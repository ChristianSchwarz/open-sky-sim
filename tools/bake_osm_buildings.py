#!/usr/bin/env python3
"""Bake OSM building footprints into per-leaf vector files (.bvr) in the planet pyramid.

Fetches every ``building=*`` way and multipolygon relation, reads the tags
that say how a building looks from the air - its kind, height, levels,
roof shape and colours - and files each one whole under the z12 leaf that
holds its centroid, the way bridges are filed by their midpoint: a
building cut at a tile border would lose a wall. ``tools/bake_planet_buildings.ts``
turns these into the ``.pbh`` sidecars the runtime extrudes, deciding the
height and roof form from these tags or, without them, from the footprint.

Nothing is decided here beyond parsing: a tag that says nothing usable is
stored as missing (NaN, or 0 for the enums), so the heuristics can change
without a re-fetch. ``building:part`` outlines are not read yet (phase 1 of
docs/terrain-buildings.md).

Usage::

    python tools/bake_osm_buildings.py --bbox 11.03,47.46,11.17,47.60
    python tools/bake_osm_buildings.py --bbox 13.30,52.48,13.45,52.56 --pbf germany.osm.pbf

Requires ``shapely`` and ``requests``.
"""

from __future__ import annotations

import argparse
import math
import os
import re
import struct
import sys
import time
import zlib
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

try:
    from shapely.geometry import Polygon
except ImportError:
    print('error: shapely is required (pip install shapely)', file=sys.stderr)
    raise

from osm_pbf import pbf_elements_groups
from osm_common import (
    OVERPASS_OUT,
    Bounds,
    glue_negative_bbox,
    load_manifest,
    nodes_map,
    overpass_fetch_groups,
    parse_bbox,
    relation_polygons,
    replace_file,
    snap_bounds_to_tiles,
    tile_range_for_bounds,
    update_manifest,
    ways_map,
)
from bake_osm_roads import known_tiles

BVR_MAGIC = b'BVR1'

# Buildings are dense: a z11 cell of a city is tens of thousands of ways,
# a z8 cell (the road grid) would be millions and Overpass refuses it.
BUILDING_CELL_ZOOM = 11

# A footprint smaller than this is a mapping slip or a garden shed nobody
# sees from the air.
MIN_AREA_M2 = 6.0

M_PER_DEG_LAT = 111132.92

# Keep in step with src/script/terrain/pbh.ts BuildingKind.
KIND_YES = 0
KIND_HOUSE = 1
KIND_RESIDENTIAL = 2
KIND_SMALL = 3
KIND_FARM = 4
KIND_GREENHOUSE = 5
KIND_INDUSTRIAL = 6
KIND_COMMERCIAL = 7
KIND_CIVIC = 8
KIND_RELIGIOUS = 9
KIND_ROOF = 10
KIND_TOWER = 11
KIND_TANK = 12
KIND_RUIN = 13
# Drawn by the airfield model (bake_osm_airports.py) from the same ways: kept
# in the .bvr so the LoD2 import sees the outline (and adds no twin of it),
# never drawn by the building bake.
KIND_AIRFIELD = 14

_KIND_BY_VALUE: Dict[str, int] = {}
for _kind, _values in (
    (KIND_HOUSE, ('house', 'detached', 'semidetached_house', 'bungalow', 'terrace', 'cabin',
                  'farm', 'villa', 'static_caravan', 'chalet', 'hut', 'houseboat')),
    (KIND_RESIDENTIAL, ('residential', 'apartments', 'dormitory', 'flats')),
    (KIND_SMALL, ('garage', 'garages', 'carport', 'shed', 'kiosk', 'toilets', 'service',
                  'transformer_tower', 'bunker', 'container', 'allotment_house', 'boathouse')),
    (KIND_FARM, ('barn', 'farm_auxiliary', 'stable', 'cowshed', 'sty', 'livestock', 'slurry_tank',
                 'stall', 'riding_hall')),
    (KIND_GREENHOUSE, ('greenhouse', 'glasshouse')),
    (KIND_INDUSTRIAL, ('industrial', 'warehouse', 'factory', 'manufacture', 'hangar', 'storage',
                       'depot', 'workshop', 'digester')),
    (KIND_COMMERCIAL, ('commercial', 'retail', 'office', 'supermarket', 'hotel', 'shop', 'mall',
                       'parking', 'gasometer')),
    (KIND_CIVIC, ('school', 'hospital', 'public', 'civic', 'government', 'university', 'college',
                  'kindergarten', 'train_station', 'transportation', 'sports_hall', 'stadium',
                  'grandstand', 'fire_station', 'museum', 'library', 'townhall', 'castle', 'palace',
                  'sports_centre', 'pavilion')),
    (KIND_RELIGIOUS, ('church', 'chapel', 'cathedral', 'mosque', 'temple', 'synagogue', 'religious',
                      'monastery', 'shrine', 'basilica')),
    (KIND_ROOF, ('roof', 'canopy')),
    (KIND_TOWER, ('tower', 'water_tower', 'bell_tower', 'clock_tower', 'chimney')),
    (KIND_TANK, ('storage_tank', 'silo', 'tank')),
    (KIND_RUIN, ('ruins', 'construction', 'collapsed', 'damaged')),
):
    for _v in _values:
        _KIND_BY_VALUE[_v] = _kind

# Values that mean there is no building there at all.
_NOT_A_BUILDING = frozenset(('no', 'none', 'demolished', 'razed', 'removed', 'destroyed', 'proposed',
                             'abandoned:no', 'entrance', 'bridge'))

# Drawn by the airfield model already (bake_osm_airports.py), from the same ways: KIND_AIRFIELD.
AIRFIELD_AEROWAYS = frozenset(('terminal', 'hangar', 'control_tower', 'tower'))

# Keep in step with src/script/terrain/pbh.ts RoofForm. 0 = untagged.
ROOF_SHAPES: Dict[str, int] = {
    'flat': 1, 'gabled': 2, 'hipped': 3, 'half-hipped': 4, 'skillion': 5, 'pyramidal': 6,
    'gambrel': 7, 'mansard': 8, 'dome': 9, 'onion': 10, 'round': 11, 'saltbox': 12, 'cone': 13,
    'side_hipped': 3, 'side_half-hipped': 4, 'quadruple_saltbox': 3, 'crosspitched': 2,
    'double_saltbox': 2, 'lean_to': 5, 'shed': 5, 'gable': 2, 'hip': 3, 'pyramid': 6,
}

ORIENTATION_ALONG = 1
ORIENTATION_ACROSS = 2

COMPASS_DEG = {
    'N': 0.0, 'NNE': 22.5, 'NE': 45.0, 'ENE': 67.5, 'E': 90.0, 'ESE': 112.5, 'SE': 135.0, 'SSE': 157.5,
    'S': 180.0, 'SSW': 202.5, 'SW': 225.0, 'WSW': 247.5, 'W': 270.0, 'WNW': 292.5, 'NW': 315.0, 'NNW': 337.5,
}

# The CSS names OSM colour tags use, plus the few non-CSS words mappers use
# for roofs. Anything else is stored as missing.
NAMED_COLOURS: Dict[str, int] = {
    'black': 0x000000, 'white': 0xffffff, 'red': 0xff0000, 'darkred': 0x8b0000, 'maroon': 0x800000,
    'brown': 0xa52a2a, 'saddlebrown': 0x8b4513, 'sienna': 0xa0522d, 'chocolate': 0xd2691e,
    'firebrick': 0xb22222, 'indianred': 0xcd5c5c, 'brick': 0xb5503c, 'terracotta': 0xc0603c,
    'orange': 0xffa500, 'darkorange': 0xff8c00, 'coral': 0xff7f50, 'tomato': 0xff6347,
    'tan': 0xd2b48c, 'beige': 0xf5f5dc, 'wheat': 0xf5deb3, 'khaki': 0xf0e68c, 'cream': 0xfffdd0,
    'ivory': 0xfffff0, 'linen': 0xfaf0e6, 'yellow': 0xffff00, 'gold': 0xffd700, 'olive': 0x808000,
    'green': 0x008000, 'darkgreen': 0x006400, 'lightgreen': 0x90ee90, 'seagreen': 0x2e8b57,
    'darkolivegreen': 0x556b2f, 'teal': 0x008080, 'turquoise': 0x40e0d0, 'cyan': 0x00ffff,
    'blue': 0x0000ff, 'navy': 0x000080, 'darkblue': 0x00008b, 'lightblue': 0xadd8e6, 'steelblue': 0x4682b4,
    'purple': 0x800080, 'pink': 0xffc0cb,
    'grey': 0x808080, 'gray': 0x808080, 'darkgrey': 0xa9a9a9, 'darkgray': 0xa9a9a9,
    'lightgrey': 0xd3d3d3, 'lightgray': 0xd3d3d3, 'dimgrey': 0x696969, 'dimgray': 0x696969,
    'silver': 0xc0c0c0, 'gainsboro': 0xdcdcdc, 'slategrey': 0x708090, 'slategray': 0x708090,
    'darkslategrey': 0x2f4f4f, 'darkslategray': 0x2f4f4f, 'lightslategray': 0x778899,
    'anthracite': 0x383e42, 'copper': 0x4f9a83,
}

_NUMBER = re.compile(r'[-+]?\d+(?:[.,]\d+)?')
_FEET_INCHES = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*\")?\s*$")


@dataclass
class Building:
    osm_id: int  # way id, or minus the relation id
    kind: int
    roof_shape: int
    roof_orientation: int
    height: float
    min_height: float
    levels: float
    roof_height: float
    roof_levels: float
    roof_direction: float
    roof_colour: int  # 0xRRGGBB or -1
    wall_colour: int
    rings: List[List[Tuple[float, float]]] = field(default_factory=list)  # outer first, open (no repeat)


def parse_length_m(text: Optional[str]) -> float:
    """A length tag in metres: '12', '12 m', '12.5m', '40 ft', 40'6"; NaN if unreadable."""
    if not text:
        return math.nan
    text = text.strip().split(';')[0]
    fi = _FEET_INCHES.match(text)
    if fi:
        return float(fi.group(1)) * 0.3048 + (float(fi.group(2)) * 0.0254 if fi.group(2) else 0.0)
    m = _NUMBER.search(text)
    if not m:
        return math.nan
    value = float(m.group(0).replace(',', '.'))
    rest = text[m.end():].strip().lower()
    if rest.startswith('ft') or rest.startswith('feet'):
        value *= 0.3048
    elif rest.startswith('km'):
        value *= 1000.0
    elif rest.startswith('cm'):
        value /= 100.0
    if not math.isfinite(value) or value < 0 or value > 1000:
        return math.nan
    return value


def parse_count(text: Optional[str]) -> float:
    if not text:
        return math.nan
    m = _NUMBER.search(text.split(';')[0])
    if not m:
        return math.nan
    value = float(m.group(0).replace(',', '.'))
    return value if 0 <= value <= 200 else math.nan


def parse_direction_deg(text: Optional[str]) -> float:
    if not text:
        return math.nan
    text = text.strip().upper()
    if text in COMPASS_DEG:
        return COMPASS_DEG[text]
    m = _NUMBER.search(text)
    if not m:
        return math.nan
    return float(m.group(0).replace(',', '.')) % 360.0


def parse_colour(text: Optional[str]) -> int:
    """'#rgb', '#rrggbb' or a colour name as 0xRRGGBB; -1 if unreadable."""
    if not text:
        return -1
    text = text.strip().lower().split(';')[0].replace(' ', '').replace('_', '')
    if text.startswith('#'):
        hexpart = text[1:]
        if len(hexpart) == 3 and all(c in '0123456789abcdef' for c in hexpart):
            return int(''.join(c * 2 for c in hexpart), 16)
        if len(hexpart) == 6 and all(c in '0123456789abcdef' for c in hexpart):
            return int(hexpart, 16)
        return -1
    return NAMED_COLOURS.get(text, -1)


def building_kind(tags: dict) -> int:
    if tags.get('aeroway') in AIRFIELD_AEROWAYS:
        return KIND_AIRFIELD
    value = (tags.get('building') or '').strip().lower()
    kind = _KIND_BY_VALUE.get(value)
    if kind is not None:
        return kind
    # building=yes says nothing; what the building is for often does.
    amenity = tags.get('amenity', '')
    if amenity == 'place_of_worship':
        return KIND_RELIGIOUS
    if amenity in ('school', 'hospital', 'university', 'college', 'kindergarten', 'townhall',
                   'fire_station', 'library', 'police'):
        return KIND_CIVIC
    if tags.get('shop') or amenity in ('restaurant', 'fuel', 'bank', 'cafe'):
        return KIND_COMMERCIAL
    if tags.get('man_made') in ('storage_tank', 'silo'):
        return KIND_TANK
    if tags.get('man_made') in ('tower', 'water_tower', 'chimney'):
        return KIND_TOWER
    if tags.get('industrial') or tags.get('craft'):
        return KIND_INDUSTRIAL
    return KIND_YES


def building_tag_predicate(tags: dict) -> bool:
    """The test `overpass_buildings_query` encodes as QL, for the PBF path."""
    value = tags.get('building')
    if not value or value.strip().lower() in _NOT_A_BUILDING:
        return False
    if tags.get('location') == 'underground':
        return False
    return True


def overpass_buildings_query(c: Bounds) -> str:
    return f'''[out:json][timeout:240];
(
  way["building"]["building"!="no"]({c.as_overpass()});
  relation["building"]["type"="multipolygon"]({c.as_overpass()});
);
{OVERPASS_OUT}
'''


def _orientation(tags: dict) -> int:
    value = (tags.get('roof:orientation') or '').strip().lower()
    return ORIENTATION_ALONG if value == 'along' else ORIENTATION_ACROSS if value == 'across' else 0


def building_from_tags(osm_id: int, tags: dict, rings: List[List[Tuple[float, float]]]) -> Building:
    return Building(
        osm_id=osm_id,
        kind=building_kind(tags),
        roof_shape=ROOF_SHAPES.get((tags.get('roof:shape') or '').strip().lower(), 0),
        roof_orientation=_orientation(tags),
        height=parse_length_m(tags.get('height') or tags.get('building:height')),
        min_height=parse_length_m(tags.get('min_height') or tags.get('building:min_height')),
        levels=parse_count(tags.get('building:levels') or tags.get('levels')),
        roof_height=parse_length_m(tags.get('roof:height')),
        roof_levels=parse_count(tags.get('roof:levels')),
        roof_direction=parse_direction_deg(tags.get('roof:direction')),
        roof_colour=parse_colour(tags.get('roof:colour') or tags.get('roof:color')),
        wall_colour=parse_colour(tags.get('building:colour') or tags.get('building:color')),
        rings=rings,
    )


def _open_ring(coords: Sequence[Tuple[float, float]]) -> List[Tuple[float, float]]:
    pts = [(float(x), float(y)) for x, y in coords]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    return pts


def _area_m2(poly: Polygon) -> float:
    lat = poly.representative_point().y
    return poly.area * M_PER_DEG_LAT * M_PER_DEG_LAT * math.cos(math.radians(lat))


def assemble_buildings(data: dict) -> List[Building]:
    """Every building in an answer, one entry per closed outline."""
    elements = data.get('elements', [])
    nodes = nodes_map(elements)
    ways = ways_map(elements)
    out: List[Building] = []
    for way in ways.values():
        tags = way.get('tags') or {}
        if not building_tag_predicate(tags):
            continue
        ids = way.get('nodes') or []
        if len(ids) < 4 or ids[0] != ids[-1]:
            continue
        pts = [nodes[i] for i in ids if i in nodes]
        if len(pts) != len(ids):
            continue
        try:
            poly = Polygon(pts)
        except Exception:
            continue
        if not poly.is_valid:
            poly = poly.buffer(0)
            if not isinstance(poly, Polygon):
                continue
        if poly.is_empty or _area_m2(poly) < MIN_AREA_M2:
            continue
        out.append(building_from_tags(way['id'], tags, [_open_ring(poly.exterior.coords)]))
    for rel in elements:
        if rel.get('type') != 'relation':
            continue
        tags = rel.get('tags') or {}
        if tags.get('type') != 'multipolygon' or not building_tag_predicate(tags):
            continue
        for poly in relation_polygons(rel, ways, nodes):
            if poly.is_empty or _area_m2(poly) < MIN_AREA_M2:
                continue
            rings = [_open_ring(poly.exterior.coords)] + [_open_ring(r.coords) for r in poly.interiors]
            out.append(building_from_tags(-rel['id'], tags, rings))
    return out


def building_centroid(b: Building) -> Tuple[float, float]:
    try:
        c = Polygon(b.rings[0]).centroid
        return c.x, c.y
    except Exception:
        xs = [p[0] for p in b.rings[0]]
        ys = [p[1] for p in b.rings[0]]
        return sum(xs) / len(xs), sum(ys) / len(ys)


def buildings_by_tile(buildings: Sequence[Building], z: int, bbox: Bounds) -> Dict[Tuple[int, int], List[Building]]:
    """Each building filed under the one tile of level `z` holding its centroid, never clipped."""
    out: Dict[Tuple[int, int], List[Building]] = {}
    for b in buildings:
        lon, lat = building_centroid(b)
        if not (bbox.west <= lon < bbox.east and bbox.south <= lat < bbox.north):
            continue
        x, y, _x1, _y1 = tile_range_for_bounds(z, Bounds(lon, lat, lon, lat))
        out.setdefault((x, y), []).append(b)
    return out


# --- BVR1 ------------------------------------------------------------------
#
# Little-endian, the whole payload zlib-compressed:
#   'BVR1' | f64 lon0 | f64 lat0 | u32 count |
#   per building:
#     i64 osm id (way > 0, relation < 0) | u8 kind | u8 roof shape | u8 roof orientation | u8 rings |
#     f32 height | f32 min_height | f32 levels | f32 roof height | f32 roof levels | f32 roof direction |
#     i32 roof colour | i32 wall colour (0xRRGGBB, -1 = none) |
#     per ring: u16 n | n x (f32 lon - lon0, f32 lat - lat0), open (first point not repeated)
# Missing numbers are NaN. Keep in step with tools/bake/bvr.ts.

_HEAD = struct.Struct('<4sddI')
_REC = struct.Struct('<qBBBBffffffii')


def encode_bvr(buildings: Sequence[Building]) -> bytes:
    lon0 = min((p[0] for b in buildings for r in b.rings for p in r), default=0.0)
    lat0 = min((p[1] for b in buildings for r in b.rings for p in r), default=0.0)
    parts = [_HEAD.pack(BVR_MAGIC, lon0, lat0, len(buildings))]
    for b in buildings:
        parts.append(_REC.pack(
            b.osm_id, b.kind, b.roof_shape, b.roof_orientation, len(b.rings),
            b.height, b.min_height, b.levels, b.roof_height, b.roof_levels, b.roof_direction,
            b.roof_colour, b.wall_colour))
        for ring in b.rings:
            parts.append(struct.pack('<H', len(ring)))
            parts.append(struct.pack(f'<{2 * len(ring)}f', *[v for lon, lat in ring for v in (lon - lon0, lat - lat0)]))
    return zlib.compress(b''.join(parts), 6)


def decode_bvr(blob: bytes) -> List[Building]:
    data = zlib.decompress(blob)
    magic, lon0, lat0, count = _HEAD.unpack_from(data, 0)
    if magic != BVR_MAGIC:
        raise ValueError(f'not a BVR1 file: {magic!r}')
    off = _HEAD.size
    out: List[Building] = []
    for _ in range(count):
        (osm_id, kind, shape, orient, nrings, height, min_height, levels, roof_height, roof_levels,
         roof_direction, roof_colour, wall_colour) = _REC.unpack_from(data, off)
        off += _REC.size
        rings: List[List[Tuple[float, float]]] = []
        for _r in range(nrings):
            (n,) = struct.unpack_from('<H', data, off)
            off += 2
            vals = struct.unpack_from(f'<{2 * n}f', data, off)
            off += 8 * n
            rings.append([(lon0 + vals[2 * i], lat0 + vals[2 * i + 1]) for i in range(n)])
        out.append(Building(osm_id, kind, shape, orient, height, min_height, levels, roof_height,
                            roof_levels, roof_direction, roof_colour, wall_colour, rings))
    return out


def bvr_path(out_dir: str, z: int, x: int, y: int) -> str:
    return os.path.join(out_dir, str(z), str(x), f'{y}.bvr')


# --- bake --------------------------------------------------------------------

def bake(args: argparse.Namespace) -> int:
    started = time.time()
    manifest_path = args.manifest or os.path.join(args.out, 'manifest.json')
    if not os.path.isfile(manifest_path):
        print(f'error: manifest not found: {manifest_path}', file=sys.stderr)
        return 2
    manifest = load_manifest(manifest_path)
    out_dir = args.out or os.path.dirname(manifest_path)
    leaf = manifest.get('maxZoom', 12)
    cov = manifest.get('coverage', {})
    asked = parse_bbox(args.bbox) if args.bbox else Bounds(cov['west'], cov['south'], cov['east'], cov['north'])
    bbox = snap_bounds_to_tiles(asked, leaf)
    print(f'coverage    lon [{bbox.west:.5f}, {bbox.east:.5f}] lat [{bbox.south:.5f}, {bbox.north:.5f}]')

    if args.pbf:
        print(f'reading OSM buildings from {args.pbf}', flush=True)
        data = pbf_elements_groups(args.pbf, bbox, [('buildings', building_tag_predicate)],
                                   include_relations=True, refresh=args.refresh_osm)['buildings']
    else:
        print('fetching OSM buildings', flush=True)
        received = [0]

        def on_progress(_g: int, n: int) -> None:
            if n - received[0] > 8 * 1024 * 1024:
                received[0] = n
                print(f'  {n / 1048576:.1f} MB received', flush=True)

        data = overpass_fetch_groups([(overpass_buildings_query, 'buildings', None)], bbox,
                                     args.refresh_osm, on_progress=on_progress,
                                     zoom=args.cell_zoom)[0]
    if args.fetch_only:
        print('fetch-only: cache filled, nothing baked')
        return 0

    buildings = assemble_buildings(data)
    print(f'assembled   {len(buildings)} buildings', flush=True)
    owned = buildings_by_tile(buildings, leaf, bbox)
    tiles = known_tiles(out_dir, manifest, leaf, leaf).get(leaf, set())
    x0, y0, x1, y1 = tile_range_for_bounds(leaf, bbox)
    files = 0
    written = 0
    size = 0
    removed = 0
    for x, y in sorted(tiles):
        if not (x0 <= x <= x1 and y0 <= y <= y1):
            continue
        path = bvr_path(out_dir, leaf, x, y)
        items = owned.get((x, y))
        if not items:
            if os.path.isfile(path):
                os.remove(path)
                removed += 1
            continue
        items.sort(key=lambda b: b.osm_id)
        blob = encode_bvr(items)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        replace_file(path, blob)
        files += 1
        written += len(items)
        size += len(blob)

    def set_buildings(manifest: dict) -> None:
        previous = (manifest.get('buildings') or {}).get('coverage')
        merged = {
            'west': min(previous['west'], bbox.west) if previous else bbox.west,
            'south': min(previous['south'], bbox.south) if previous else bbox.south,
            'east': max(previous['east'], bbox.east) if previous else bbox.east,
            'north': max(previous['north'], bbox.north) if previous else bbox.north,
        }
        manifest['buildings'] = {'path': '{z}/{x}/{y}.bvr', 'source': 'osm', 'zoom': leaf, 'coverage': merged}
    update_manifest(manifest_path, set_buildings)
    print(f'wrote {files} leaf tiles, {written} buildings, {size / 1048576:.1f} MB (.bvr)'
          + (f'; removed {removed} stale' if removed else ''))
    print(f'done in {time.time() - started:.1f}s')
    return 0


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--manifest', help='planet manifest.json (default: {out}/manifest.json)')
    parser.add_argument('--out', default='assets/planet', help='planet asset directory')
    parser.add_argument('--bbox', help='west,south,east,north degrees (default: manifest coverage)')
    parser.add_argument('--pbf', help='read buildings from this local .osm.pbf instead of Overpass')
    parser.add_argument('--cell-zoom', type=int, default=BUILDING_CELL_ZOOM,
                        help=f'Overpass cell grid zoom (default {BUILDING_CELL_ZOOM})')
    parser.add_argument('--refresh-osm', action='store_true', help='ignore cached answers and re-fetch')
    parser.add_argument('--fetch-only', action='store_true', help='only fill the cache; bake nothing')
    raw = list(argv) if argv is not None else sys.argv[1:]
    return bake(parser.parse_args(glue_negative_bbox(raw)))


if __name__ == '__main__':
    raise SystemExit(main())

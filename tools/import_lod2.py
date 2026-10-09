#!/usr/bin/env python3
"""Match official LoD2 building models to the OSM buildings of each leaf (phase 4 of docs/terrain-buildings.md).

LoD2 city models give, per building, the roof type the surveying office
assigned, the ground, eave and ridge heights and the roof surfaces - what
phases 1-3 can only guess or fit. Per z12 leaf with OSM footprints (.bvr),
the LoD2 tiles under it are read and every OSM building is given the LoD2
building(s) standing on it: their roof form (AdV roof type mapped onto the
runtime's forms), eave and ridge above the ground, and the ridge direction
from the largest roof surface. Only the answers are kept, keyed by OSM id,
in the LoD2 store (BLS1, data/imports/buildings/lod2/12/x/y.bls), which
tools/bake_planet_buildings.ts puts above the surface fits and the rules,
and tools/eval_buildings.ts scores the other sources against. The OSM
footprints stay: the roof colours and surface fits are keyed by them.

Missing buildings. OSM lacks a quarter of what LoD2 has in Garmisch -
mostly garages and sheds, but 149 buildings over 100 m2 in the town leaf
alone. Every LoD2 building whose representative point is in the leaf, that
stands under no OSM footprint of the leaf or its eight neighbours (OSM
files by centroid, so an outline can sit across the border) and overlaps
them by less than MISSING_MAX_OVERLAP of its area, is written to the
leaf's .bvl (the .bvr's BVR1 format, beside it in the planet pyramid) with
a stable id (LOD2_ID_BASE + the number in its gml:id), a kind from its AdV
building function, and its own LoD2 record in the store - so every later
stage (roof colours, the bake) takes it like an OSM building, and the bake
gives it LoD2's form and heights.

Matching. A LoD2 building belongs to the OSM footprint holding its
representative point. One LoD2 building of about the same area (0.6-1.6x)
is a ONE match; several whose areas add up to it (OSM drew a terrace or a
farm as one outline) is MERGED, the largest giving form and ridge and the
area-weighted mean the heights; anything else is PARTIAL and the heights
only are offered.

Sources (SOURCES), all AdV CityGML 1.0 in DHHN2016, kept gzipped under
CACHE_ROOT/<source>:

  Bavaria       CC BY 4.0, "Datenquelle: Bayerische Vermessungsverwaltung -
                www.geodaten.bayern.de"; 2 km tiles named by their south-west
                corner in km (even numbers), EPSG:25832, ~50 MB each (~8 MB
                gzipped). Ground, ridge and lowest eave are attributes of each
                building.
  Brandenburg   dl-de/by-2-0, "(c) GeoBasis-DE/LGB"; 1 km zipped tiles,
                EPSG:25833 (Berlin's buildings are not in them).
  Berlin        dl-de/zero-2-0, Geoportal Berlin; 1 km zipped tiles,
                EPSG:25833.

Brandenburg's and Berlin's buildings are split into bldg:BuildingPart (a
wing, a tower), each with its own roof type and surfaces, and carry no
height attributes: each part is taken as a LoD2 building of its own, the
parent's function handed down, and ground, ridge and lowest eave are read
off its GroundSurface and RoofSurface coordinates. swissBUILDINGS3D and the
other German states are not wired yet.

Usage::

    python tools/import_lod2.py --bbox 11.03,47.46,11.17,47.60
    python tools/import_lod2.py --leaf 4348,967 --force
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import math
import os
import re
import struct
import sys
import time
import urllib.error
import urllib.request
import zipfile
import zlib
from concurrent.futures import ProcessPoolExecutor, as_completed
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
from shapely.geometry import Polygon
from shapely.strtree import STRtree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_osm_buildings import (  # noqa: E402
    KIND_CIVIC, KIND_COMMERCIAL, KIND_FARM, KIND_HOUSE, KIND_INDUSTRIAL, KIND_RELIGIOUS, KIND_RESIDENTIAL,
    KIND_ROOF, KIND_SMALL, KIND_YES, Building, decode_bvr, encode_bvr,
)

LEAF_ZOOM = 12
PLANET_DIR = 'assets/planet'
STORE_DIR = 'data/imports/buildings/lod2'
CACHE_ROOT = 'data/imports/lod2/.cache'
USER_AGENT = 'retroflightsim-terrain-bake (LoD2 matcher)'

# Keep in step with tools/bake/buildingLod2Store.ts.
BLS_MAGIC = b'BLS1'
BLS_VERSION = 1
_BLS_HEAD = struct.Struct('<4sBBHII')  # magic, version, 0, 0, bvr crc32, count
# id, form (0 = none fits), match, adv roof type, azimuth (0.01 deg, 0xFFFF = none), eave (cm), ridge (cm), parts
_BLS_REC = struct.Struct('<qBBHHHHB')

MATCH_ONE, MATCH_MERGED, MATCH_PARTIAL = 1, 2, 3
MATCH_NAMES = {MATCH_ONE: 'one', MATCH_MERGED: 'merged', MATCH_PARTIAL: 'partial'}
NO_AZIMUTH = 0xFFFF

# Ids of buildings only LoD2 has: above every OSM id (a way id is under 2^34)
# and below 2^53, so a JS Number holds them exactly.
LOD2_ID_BASE = 1 << 52
MIN_AREA_M2 = 6.0
MISSING_MAX_OVERLAP = 0.2

# RoofForm values (src/script/terrain/pbh.ts).
FLAT, GABLED, HIPPED, HALF_HIPPED, SKILLION, PYRAMIDAL = 1, 2, 3, 4, 5, 6
# AdV roof type codes onto the runtime's forms; 0 = none of them (mixed, other).
ADV_FORM = {
    1000: FLAT,          # Flachdach
    2100: SKILLION,      # Pultdach
    2200: SKILLION,      # versetztes Pultdach
    3100: GABLED,        # Satteldach
    3200: HIPPED,        # Walmdach
    3300: HALF_HIPPED,   # Krueppelwalmdach
    3400: HIPPED,        # Mansardendach: a hip with a break, closest of the six
    3500: PYRAMIDAL,     # Zeltdach
    3600: PYRAMIDAL,     # Kegeldach
    3700: PYRAMIDAL,     # Kuppeldach
    3800: SKILLION,      # Sheddach: a row of skillions
    3900: GABLED,        # Bogendach: a barrel, ridged along its length
    4000: PYRAMIDAL,     # Turmdach
    5000: 0,             # Mischform
    9999: 0,             # sonstiges
}


def kind_of_function(function: str, area: float) -> Optional[int]:
    """A BuildingKind from an AdV building function ('31001_1000'), or None for no building to draw."""
    cls, _, code = function.partition('_')
    try:
        c = int(code)
    except ValueError:
        return KIND_YES
    if cls == '53001':
        return None  # Bauwerk im Verkehrsbereich: bridge and tunnel parts, drawn by the road bake
    if cls == '51009':
        return KIND_ROOF if c == 1610 else None  # Ueberdachung; other structures (walls, masts) are not houses
    if 1000 <= c < 2000:
        return KIND_HOUSE if area < 250 else KIND_RESIDENTIAL
    if 2460 <= c < 2470 or c == 2523:
        return KIND_SMALL  # garages, transformer houses
    if 2700 <= c < 2800:
        return KIND_FARM
    if 2100 <= c < 2200:
        return KIND_INDUSTRIAL
    if c == 2000:
        return KIND_YES  # Wirtschaft oder Gewerbe: in the country, barns and sheds as much as shops
    if 2000 < c < 3000:
        return KIND_COMMERCIAL
    if 3040 <= c < 3050:
        return KIND_RELIGIOUS
    if 3000 <= c < 4000:
        return KIND_CIVIC
    return KIND_YES


def lod2_osm_id(gml_id: str) -> int:
    """Bavaria's ids end in a serial number ('DEBY_LOD2_75192'); every other id
    ('DEBBAL010009e6j7', 'GUID_1476444944285_13050491' - numbers, but not one
    series) takes a 40-bit hash instead, above every serial."""
    m = re.fullmatch(r'DEBY_LOD2_(\d+)', gml_id)
    if m and int(m.group(1)) < (1 << 40):
        return LOD2_ID_BASE + int(m.group(1))
    digest = hashlib.blake2b(gml_id.encode(), digest_size=5).digest()
    return LOD2_ID_BASE + (1 << 40) + int.from_bytes(digest, 'little')


def tile_bounds(z: int, x: int, y: int) -> Tuple[float, float, float, float]:
    span = 180.0 / (1 << z)
    west = -180.0 + x * span
    north = 90.0 - y * span
    return west, north - span, west + span, north


def planet_path(x: int, y: int, ext: str) -> str:
    return os.path.join(PLANET_DIR, str(LEAF_ZOOM), str(x), f'{y}{ext}')


def store_path(x: int, y: int) -> str:
    return os.path.join(STORE_DIR, str(LEAF_ZOOM), str(x), f'{y}.bls')


def crc32_file(path: str) -> int:
    with open(path, 'rb') as fh:
        return zlib.crc32(fh.read()) & 0xFFFFFFFF


def to_utm(lons: Sequence[float], lats: Sequence[float], crs: str = 'EPSG:25832') -> Tuple[np.ndarray, np.ndarray]:
    from rasterio.warp import transform
    xs, ys = transform('EPSG:4326', crs, list(lons), list(lats))
    return np.asarray(xs), np.asarray(ys)


# --- LoD2 tiles ---------------------------------------------------------------

def http_get(url: str) -> Optional[bytes]:
    """The body, or None for a missing file (4xx) or after the retries."""
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read()
        except urllib.error.HTTPError as ex:
            if 400 <= ex.code < 500 and ex.code not in (408, 429):
                return None
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(3 * (attempt + 1))
    return None


class Source:
    """One surveying office's LoD2: its tiling, projection and download."""
    name = ''
    crs = ''
    # A coarse lon/lat box; a leaf outside it asks for no tile.
    box = (0.0, 0.0, 0.0, 0.0)
    tile_m = 1000

    def covers(self, w: float, s: float, e: float, n: float) -> bool:
        bw, bs, be, bn = self.box
        return not (e < bw or w > be or n < bs or s > bn)

    def download(self, e_km: int, n_km: int) -> Optional[bytes]:
        raise NotImplementedError

    def tiles_for(self, x: int, y: int) -> List[Tuple[int, int]]:
        w, s, e, n = tile_bounds(LEAF_ZOOM, x, y)
        xs, ys = to_utm([w, e, w, e], [s, s, n, n], self.crs)
        pad = 200  # buildings are filed by centroid and overhang the leaf
        step = self.tile_m // 1000
        e0 = int((xs.min() - pad) // self.tile_m) * step
        e1 = int((xs.max() + pad) // self.tile_m) * step
        n0 = int((ys.min() - pad) // self.tile_m) * step
        n1 = int((ys.max() + pad) // self.tile_m) * step
        return [(ek, nk) for ek in range(e0, e1 + 1, step) for nk in range(n0, n1 + 1, step)]

    def fetch(self, e_km: int, n_km: int) -> Optional[bytes]:
        """The CityGML of the tile with south-west corner (e_km, n_km), or None where there is none."""
        cache = os.path.join(CACHE_ROOT, self.name)
        path = os.path.join(cache, f'{e_km}_{n_km}.gml.gz')
        none = path[:-7] + '.none'
        if os.path.exists(none):
            return None
        if os.path.exists(path):
            with gzip.open(path, 'rb') as fh:
                return fh.read()
        data = self.download(e_km, n_km)
        os.makedirs(cache, exist_ok=True)
        if data is None or b'<bldg:Building' not in data[:200000] and b'CityModel' not in data[:2000]:
            open(none, 'wb').close()
            return None
        tmp = f'{path}.{os.getpid()}.part'
        with gzip.open(tmp, 'wb', compresslevel=6) as fh:
            fh.write(data)
        os.replace(tmp, path)
        return data


def unzip_citygml(blob: Optional[bytes]) -> Optional[bytes]:
    """The largest .gml/.xml member of a zipped tile (any other is metadata)."""
    if blob is None:
        return None
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            members = [i for i in z.infolist() if i.filename.lower().endswith(('.gml', '.xml'))]
            return z.read(max(members, key=lambda i: i.file_size)) if members else None
    except zipfile.BadZipFile:
        return None


class Bavaria(Source):
    name = 'bavaria'
    crs = 'EPSG:25832'
    box = (8.95, 47.25, 13.86, 50.58)
    tile_m = 2000

    def download(self, e_km, n_km):
        return http_get(f'https://download1.bayernwolke.de/a/lod2/citygml/{e_km}_{n_km}.gml')


class Brandenburg(Source):
    name = 'brandenburg'
    crs = 'EPSG:25833'
    box = (11.2, 51.3, 14.8, 53.6)

    def download(self, e_km, n_km):
        return unzip_citygml(http_get(
            f'https://data.geobasis-bb.de/geobasis/daten/3d_gebaeude/lod2_gml/lod2_33{e_km}-{n_km}.zip'))


class Berlin(Source):
    name = 'berlin'
    crs = 'EPSG:25833'
    box = (13.05, 52.33, 13.78, 52.69)

    def download(self, e_km, n_km):
        return unzip_citygml(http_get(f'https://gdi.berlin.de/data/a_lod2/atom/LoD2_{e_km}_{n_km}.zip'))


SOURCES: List[Source] = [Bavaria(), Brandenburg(), Berlin()]


_ATTR = {name: re.compile(rf'name="{name}">\s*<gen:value>([-\d.]+)<') for name in
         ('HoeheGrund', 'HoeheDach', 'NiedrigsteTraufeDesGebaeudes')}
_ROOF_TYPE = re.compile(r'<bldg:roofType>(\d+)<')
# The first posList of each surface, its exterior ring. Bavaria writes a bare
# <gml:posList>, Brandenburg and Berlin add srsDimension="3".
_GROUND = re.compile(r'<bldg:GroundSurface.*?<gml:posList[^>]*>([^<]+)<', re.S)
_ROOF = re.compile(r'<bldg:RoofSurface.*?<gml:posList[^>]*>([^<]+)<', re.S)
_OBJECT = re.compile(r'<bldg:(Building|BuildingPart) ')
_ID = re.compile(r'gml:id="([^"]+)"')
_FUNCTION = re.compile(r'<bldg:function>([^<]+)<')


def newell(p: np.ndarray) -> np.ndarray:
    a, b = p, np.roll(p, -1, axis=0)
    return np.array([np.sum((a[:, 1] - b[:, 1]) * (a[:, 2] + b[:, 2])),
                     np.sum((a[:, 2] - b[:, 2]) * (a[:, 0] + b[:, 0])),
                     np.sum((a[:, 0] - b[:, 0]) * (a[:, 1] + b[:, 1]))])


def ridge_azimuth(roofs: List[np.ndarray], form: int) -> Optional[float]:
    """Compass degrees of the ridge axis in the runtime's sense, from the largest sloped roof surface.

    The surface's normal leans downhill; a gable's ridge runs square to that.
    For a skillion the runtime's axis is the one whose quarter turn
    counter-clockwise (seen from above) points uphill.
    """
    best, best_area = None, 0.0
    for v in roofs:
        if len(v) < 3:
            continue
        nn = newell(v)
        length = float(np.linalg.norm(nn))
        if length <= 0:
            continue
        if nn[2] < 0:
            nn = -nn  # roof normals point up and out
        horiz = math.hypot(nn[0], nn[1])
        if horiz < 0.08 * length:
            continue  # a flat piece says nothing about direction
        area = length / 2
        if area > best_area:
            best_area, best = area, nn
    if best is None:
        return None
    downhill = math.degrees(math.atan2(best[0], best[1])) % 360  # compass of the normal's horizontal part
    if form == SKILLION:
        return (downhill + 180 + 90) % 360  # uphill, turned a quarter clockwise back to the axis
    return (downhill + 90) % 180


def parse_lod2(gml: bytes) -> List[dict]:
    text = gml.decode('utf-8', errors='replace')
    out = []
    function = ''
    pieces = _OBJECT.split(text)
    for tag, chunk in zip(pieces[1::2], pieces[2::2]):
        fn = _FUNCTION.search(chunk)
        if tag == 'Building':
            function = fn.group(1) if fn else ''
        L = parse_object(chunk, fn.group(1) if fn else function)
        if L is not None:
            out.append(L)
    return out


def parse_object(chunk: str, function: str) -> Optional[dict]:
    """One bldg:Building or bldg:BuildingPart with a footprint of its own, or None."""
    gs = _GROUND.search(chunk)
    if not gs:
        return None  # a building made of parts: they carry the geometry
    try:
        ground_ring = np.array(gs.group(1).split(), float).reshape(-1, 3)
        fp = Polygon(ground_ring[:, :2])
    except Exception:  # noqa: BLE001 - a broken outline is skipped
        return None
    if not fp.is_valid:
        # A self-touching outline (one in leaf 4391/853 broke every overlap
        # test after it): repaired, and its largest piece kept as the footprint.
        fp = fp.buffer(0)
        if fp.geom_type == 'MultiPolygon':
            fp = max(fp.geoms, key=lambda g: g.area)
    if fp.is_empty or fp.geom_type != 'Polygon' or fp.area < 2:
        return None
    roofs = []
    for p in _ROOF.findall(chunk):
        try:
            roofs.append(np.array(p.split(), float).reshape(-1, 3))
        except ValueError:
            pass
    g = _ATTR['HoeheGrund'].search(chunk)
    r = _ATTR['HoeheDach'].search(chunk)
    e = _ATTR['NiedrigsteTraufeDesGebaeudes'].search(chunk)
    if g and r:
        ground, ridge = float(g.group(1)), float(r.group(1))
        eave = float(e.group(1)) if e else math.nan
    elif roofs:
        # No height attributes (Brandenburg, Berlin): off the coordinates.
        ground = float(ground_ring[:, 2].min())
        ridge = max(float(v[:, 2].max()) for v in roofs)
        eave = min(float(v[:, 2].min()) for v in roofs)
    else:
        return None
    rt = _ROOF_TYPE.search(chunk)
    adv = int(rt.group(1)) if rt else 9999
    form = ADV_FORM.get(adv, 0)
    idm = _ID.search(chunk)
    return {
        'id': idm.group(1) if idm else '', 'adv': adv, 'form': form, 'area': fp.area,
        'point': fp.representative_point(), 'poly': fp, 'function': function,
        'eave': eave - ground, 'ridge': ridge - ground,
        'azimuth': ridge_azimuth(roofs, form) if form not in (0, FLAT, PYRAMIDAL) else None,
    }


# --- matching -------------------------------------------------------------------

def record(osm_id: int, parts: List[dict], kind: int) -> tuple:
    """The BLS1 fields for the LoD2 building(s) `parts` standing on one footprint."""
    largest = max(parts, key=lambda p: p['area'])
    w = np.array([p['area'] for p in parts])
    ridge = float(np.sum(w * [p['ridge'] for p in parts]) / w.sum())
    eaves = [(p['eave'], p['area']) for p in parts if math.isfinite(p['eave'])]
    eave = float(sum(e * a for e, a in eaves) / sum(a for _e, a in eaves)) if eaves else ridge
    az = largest['azimuth']
    return (osm_id, largest['form'], kind, largest['adv'],
            NO_AZIMUTH if az is None else int(round(az * 100)) % 36000,
            max(0, min(65535, int(round(max(0.0, eave) * 100)))),
            max(0, min(65535, int(round(max(0.0, ridge) * 100)))), min(255, len(parts)))


def match(buildings: List[Building], lod: List[dict], neighbours: Sequence[Building] = (),
          crs: str = 'EPSG:25832') -> Tuple[Dict[int, tuple], dict, List[dict]]:
    """OSM id -> BLS1 record fields, counts, and the LoD2 buildings under no footprint.

    `neighbours` are the OSM buildings of the leaves around: they only claim
    LoD2 buildings (so none is taken for missing), they get no records.
    """
    own = {b.osm_id for b in buildings}
    buildings = list(buildings) + [b for b in neighbours if b.osm_id not in own]
    lons = [p[0] for b in buildings for p in b.rings[0]]
    lats = [p[1] for b in buildings for p in b.rings[0]]
    xs, ys = to_utm(lons, lats, crs) if lons else (np.zeros(0), np.zeros(0))
    polys, owners = [], []
    k = 0
    for b in buildings:
        n = len(b.rings[0])
        try:
            p = Polygon(np.stack([xs[k:k + n], ys[k:k + n]], axis=1))
            if not p.is_valid:
                p = p.buffer(0)
            if not p.is_empty:
                polys.append(p)
                owners.append(b.osm_id)
        except Exception:  # noqa: BLE001
            pass
        k += n
    tree = STRtree(polys)
    by_osm: Dict[int, List[dict]] = {}
    unmatched: List[dict] = []
    for L in lod:
        hits = [h for h in tree.query(L['point'], predicate='within')]
        if not hits:
            unmatched.append(L)
            continue
        h = min(hits, key=lambda i: polys[i].area)
        by_osm.setdefault(owners[h], []).append(L)
    area_of = {owners[i]: polys[i].area for i in range(len(polys))}
    out: Dict[int, tuple] = {}
    counts = {'one': 0, 'merged': 0, 'partial': 0, 'lod2Unmatched': len(unmatched), 'lod2': len(lod)}
    for osm_id, parts in by_osm.items():
        if osm_id not in own:
            continue
        total = sum(p['area'] for p in parts)
        ratio = total / max(area_of[osm_id], 1e-6)
        if 0.6 < ratio < 1.6:
            kind = MATCH_ONE if len(parts) == 1 else MATCH_MERGED
        else:
            kind = MATCH_PARTIAL
        out[osm_id] = record(osm_id, parts, kind)
        counts[MATCH_NAMES[kind]] += 1
    # Under no footprint by its point, and hardly touching one either.
    missing = []
    for L in unmatched:
        if L['area'] < MIN_AREA_M2:
            continue
        overlap = sum(L['poly'].intersection(polys[i]).area for i in tree.query(L['poly'], predicate='intersects'))
        if overlap <= MISSING_MAX_OVERLAP * L['area']:
            missing.append(L)
    return out, counts, missing


def import_leaf(x: int, y: int) -> dict:
    t0 = time.time()
    bvr = planet_path(x, y, '.bvr')
    buildings = decode_bvr(open(bvr, 'rb').read())
    neighbours: List[Building] = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            p = planet_path(x + dx, y + dy, '.bvr')
            if (dx or dy) and os.path.exists(p):
                neighbours.extend(decode_bvr(open(p, 'rb').read()))
    # Matched once per projection the leaf's sources use (Brandenburg and
    # Berlin share one; no leaf has two yet).
    by_crs: Dict[str, List[dict]] = {}
    tiles = 0
    for src in SOURCES:
        if not src.covers(*tile_bounds(LEAF_ZOOM, x, y)):
            continue
        lod = by_crs.setdefault(src.crs, [])
        for ek, nk in src.tiles_for(x, y):
            data = src.fetch(ek, nk)
            if data is None:
                continue
            tiles += 1
            lod.extend(parse_lod2(data))
    records: Dict[int, tuple] = {}
    counts = {'one': 0, 'merged': 0, 'partial': 0, 'lod2Unmatched': 0, 'lod2': 0}
    added: List[Tuple[Building, dict]] = []
    for crs, lod in by_crs.items():
        # A building on a tile edge is in both tiles' files.
        seen, unique = set(), []
        for L in lod:
            if L['id'] and L['id'] in seen:
                continue
            seen.add(L['id'])
            unique.append(L)
        got, c, missing = match(buildings, unique, neighbours, crs)
        records.update(got)
        for k in counts:
            counts[k] += c[k]
        added.extend(missing_buildings(x, y, missing, crs))
    for b, L in added:
        records[b.osm_id] = record(b.osm_id, [L], MATCH_ONE)
    write_missing(x, y, [b for b, _L in added])
    write_store(x, y, crc32_file(bvr), list(records.values()))
    counts.update({'leaf': (x, y), 'buildings': len(buildings), 'tiles': tiles, 'seconds': time.time() - t0,
                   'added': len(added), 'addedOver100': sum(1 for _b, L in added if L['area'] > 100)})
    return counts


def missing_buildings(x: int, y: int, missing: List[dict], crs: str = 'EPSG:25832') -> List[Tuple[Building, dict]]:
    """The LoD2 buildings of `missing` that this leaf owns (point inside it), as BVR1 buildings."""
    from rasterio.warp import transform
    w, s, e, n = tile_bounds(LEAF_ZOOM, x, y)
    out = []
    for L in missing:
        kind = kind_of_function(L['function'], L['area'])
        if kind is None:
            continue
        ring = list(L['poly'].exterior.coords)[:-1]
        if len(ring) < 3:
            continue
        lons, lats = transform(crs, 'EPSG:4326', [p[0] for p in ring], [p[1] for p in ring])
        px, py = transform(crs, 'EPSG:4326', [L['point'].x], [L['point'].y])
        if not (w <= px[0] < e and s <= py[0] < n):
            continue  # its neighbour's
        eave = L['eave'] if math.isfinite(L['eave']) else L['ridge']
        out.append((Building(
            osm_id=lod2_osm_id(L['id']), kind=kind, roof_shape=L['form'], roof_orientation=0,
            height=L['ridge'], min_height=math.nan, levels=math.nan, roof_height=max(0.0, L['ridge'] - eave),
            roof_levels=math.nan, roof_direction=math.nan, roof_colour=-1, wall_colour=-1,
            rings=[list(zip(lons, lats))]), L))
    return out


def bvl_path(x: int, y: int) -> str:
    return planet_path(x, y, '.bvl')


def write_missing(x: int, y: int, buildings: List[Building]) -> None:
    path = bvl_path(x, y)
    if not buildings:
        if os.path.exists(path):
            os.remove(path)
        return
    tmp = path + '.tmp'
    with open(tmp, 'wb') as fh:
        fh.write(encode_bvr(sorted(buildings, key=lambda b: b.osm_id)))
    os.replace(tmp, path)


def encode_bls(signature: int, records) -> bytes:
    parts = [_BLS_HEAD.pack(BLS_MAGIC, BLS_VERSION, 0, 0, signature, len(records))]
    parts.extend(_BLS_REC.pack(*r) for r in sorted(records))
    return zlib.compress(b''.join(parts), 6)


def decode_bls(blob: bytes) -> Tuple[int, List[tuple]]:
    data = zlib.decompress(blob)
    magic, version, _a, _b, signature, count = _BLS_HEAD.unpack_from(data, 0)
    if magic != BLS_MAGIC or version != BLS_VERSION:
        raise ValueError('not a BLS1 file')
    return signature, [_BLS_REC.unpack_from(data, _BLS_HEAD.size + i * _BLS_REC.size) for i in range(count)]


def write_store(x: int, y: int, signature: int, records) -> None:
    path = store_path(x, y)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as fh:
        fh.write(encode_bls(signature, records))
    os.replace(tmp, path)


def up_to_date(x: int, y: int) -> bool:
    path = store_path(x, y)
    if not os.path.exists(path):
        return False
    try:
        signature, _ = decode_bls(open(path, 'rb').read())
    except (OSError, ValueError, zlib.error, struct.error):
        return False
    return signature == crc32_file(planet_path(x, y, '.bvr'))


def leaves_in(bbox: Sequence[float]) -> List[Tuple[int, int]]:
    span = 180.0 / (1 << LEAF_ZOOM)
    w, s, e, n = bbox
    x0, x1 = int(math.floor((w + 180) / span)), int(math.floor((e + 180) / span))
    y0, y1 = int(math.floor((90 - n) / span)), int(math.floor((90 - s) / span))
    out = []
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if os.path.exists(planet_path(x, y, '.bvr')) and any(
                    src.covers(*tile_bounds(LEAF_ZOOM, x, y)) for src in SOURCES):
                out.append((x, y))
    return out


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--bbox', help='west,south,east,north')
    ap.add_argument('--leaf', help='x,y of one z12 leaf')
    ap.add_argument('--force', action='store_true', help='match leaves already up to date')
    ap.add_argument('--jobs', type=int, default=max(1, min(4, (os.cpu_count() or 2) - 1)))
    args = ap.parse_args(argv)
    if args.leaf:
        leaves = [tuple(int(v) for v in args.leaf.split(','))]
    elif args.bbox:
        leaves = leaves_in([float(v) for v in args.bbox.split(',')])
    else:
        ap.error('give --bbox or --leaf')
    todo = [k for k in leaves if args.force or not up_to_date(*k)]
    print(f'import_lod2: {len(leaves)} leaves with buildings, {len(todo)} to match', flush=True)
    t0 = time.time()
    tot = {'buildings': 0, 'one': 0, 'merged': 0, 'partial': 0, 'lod2': 0, 'lod2Unmatched': 0, 'added': 0,
           'addedOver100': 0}
    failed = 0
    done = 0
    # Neighbouring leaves share LoD2 tiles: one job at a time per tile would be
    # tidier, but the cache makes a second read cheap and a race only re-downloads.
    with ProcessPoolExecutor(max(1, args.jobs)) as pool:
        futures = {pool.submit(import_leaf, x, y): (x, y) for x, y in todo}
        for f in as_completed(futures):
            x, y = futures[f]
            try:
                r = f.result()
            except Exception as ex:  # noqa: BLE001 - one leaf's failure is logged, the rest go on
                failed += 1
                print(f'  leaf {x}/{y} failed: {ex!r}', flush=True)
                continue
            done += 1
            for k in tot:
                tot[k] += r[k]
            print(f'  {done}/{len(todo)} {x}/{y}: {r["one"] + r["merged"]}/{r["buildings"]} matched '
                  f'({r["merged"]} merged, {r["partial"]} partial), {r["added"]} added from LoD2, '
                  f'{r["tiles"]} LoD2 tiles, {r["seconds"]:.0f} s', flush=True)
    m = tot['one'] + tot['merged']
    print(f'import_lod2: {m}/{tot["buildings"]} OSM buildings matched ({tot["one"]} one to one, '
          f'{tot["merged"]} merged), {tot["partial"]} partial; {tot["added"]} buildings only LoD2 has added '
          f'({tot["addedOver100"]} over 100 m2, .bvl); {failed} leaves failed; '
          f'{(time.time() - t0) / 60:.1f} min', flush=True)
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Bake OpenStreetMap aerodromes into the planet manifest.

Reads an existing ``assets/planet`` tree (manifest + heights from the DEM bake,
land mask from the coast bake), pulls ``aeroway=*`` from OpenStreetMap, and
writes an ``airfields`` block into ``manifest.json`` describing where every
airfield is, which way its runways actually point, and what plane the terrain
has to be cut to for them to sit flat.

The mesh bake reads the `pads` in that block and cuts the terrain to them, and
copies the descriptions to `assets/terrain/airfields.json`, which the runtime
draws and then flies from: real pavement, thresholds, designators and
centrelines on the plane the ground under them was cut to, with the spawns, the
ILS and the AI all working the real runways. An area with an airfield in it no
longer gets an invented pad flattened at its centre.

openairportmap.org is a front end over exactly this data: it queries Overpass
for ``aeroway`` and draws the result. So "use OpenAirportMap data" and "query
OSM through Overpass" are the same thing, and going straight to Overpass is
what gets a cacheable, offline-repeatable bake instead of a scrape.

Usage::

    python tools/bake_osm_airports.py                      # every baked area
    python tools/bake_osm_airports.py --bbox=-15.8,27.7,-15.2,28.2
    python tools/bake_osm_airports.py --dry-run            # report, write nothing

Requires ``numpy``, ``shapely`` and ``requests`` - the same set the coast bake
already needs.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import multiprocessing as mp
import os
import sys
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

import numpy as np

try:
    from shapely.geometry import Point, Polygon, box
    from shapely.strtree import STRtree
except ImportError:
    print('error: shapely is required (pip install shapely requests)', file=sys.stderr)
    raise

from osm_common import (
    Bounds,
    DemSampler,
    LAND,
    glue_negative_bbox,
    load_manifest,
    accept_empty_once,
    nodes_map,
    OVERPASS_CONCURRENCY,
    overpass_fetch,
    parse_bbox,
    read_lwm,
    relation_rings,
    tagged_width_m,
    tile_bounds,
    ways_map,
)


# --- what counts as an airfield --------------------------------------------

# Runway widths by aerodrome class, for the majority of runways OSM maps with
# no `width` tag at all. These are the ICAO code-letter norms rather than an
# average: a code E runway (747, C-17) is 45 m, a regional turboprop strip is
# 30 m, and a grass GA field is 18 m. Guessing one number for all three makes
# every small field look like an international one from the air, which is the
# single most obvious way a generated airport reads as fake.
DEFAULT_RUNWAY_WIDTH_M = {
    'international': 45.0,
    'military': 45.0,
    'regional': 30.0,
    'ga': 18.0,
}

# Taxiway widths by aerodrome class, for the taxiways OSM maps with no `width`
# tag - which is almost all of them: 667 of 684 across the baked airfields.
#
# Annex 14's table is by code letter, which is set by the wingspan the taxiway
# is built for, and that is what the aerodrome class already stands in for:
#
#   international  code E, a 45 m runway and 65 m of wingspan   23 m
#   military       code D, fighters and transports              18 m
#   regional       code C, a 30 m runway, 737s and turboprops   15 m
#   ga             code B, an 18 m strip and light twins        10.5 m
#
# One number for all of them - 23 m, the code E figure - put an international
# taxiway through every gliding club in Brandenburg.
DEFAULT_TAXIWAY_WIDTH_M = {
    'international': 23.0,
    'military': 18.0,
    'regional': 15.0,
    'ga': 10.5,
}

# Narrower than code A's 7.5 m and it is not a taxiway - a service road or a
# footpath that picked up the tag. Same treatment as an implausible runway
# width: fall back to the class default rather than draw a ribbon.
MIN_PLAUSIBLE_TAXIWAY_WIDTH_M = 5.0

# Narrowest a runway of a given length can plausibly be, metres. A `width` tag
# below this is not a narrow runway, it is a wrong tag: Dzhankoi carries
# `width=12` on a 2.5 km concrete strip, which is narrower than the taxiways
# beside it and would draw as a ribbon. Where the tag fails this the class
# default is used instead and the runway is flagged.
MIN_PLAUSIBLE_WIDTH_M = ((1800.0, 30.0), (1200.0, 23.0), (0.0, 10.0))

# Two ways for one runway. OSM frequently carries both a centreline and an
# area for the same strip, and taken at face value that is two coincident
# runways with two pads and two sets of markings.
#
# Told apart from a genuine parallel pair by perpendicular offset: duplicates
# lie on top of each other, and the closest parallel runways anywhere are 120 m
# apart because that is what ICAO requires.
DUPLICATE_OFFSET_M = 40.0
DUPLICATE_HEADING_DEG = 5.0

# Aprons small enough to be a single hardstand are not worth a flatten pad of
# their own; a Crimean military field maps ninety of them. The runway pads
# already cover the middle of the airfield, and the rest is feather.
MIN_APRON_AREA_M2 = 2500.0
MAX_APRON_PADS = 8

# Shorter than this and it is a farm strip: not worth a manifest entry, and
# short enough that the pad it would ask for is mostly feather.
MIN_RUNWAY_LENGTH_M = 500.0

# A runway way with no aerodrome polygon around it attaches to the nearest
# aerodrome node within this. Node-only aerodromes are common - plenty of
# fields are a single tagged point with the runways drawn separately.
ORPHAN_ASSIGN_RADIUS_M = 5000.0

# ICAO Annex 14 longitudinal slope limits: 1% for code 3/4 (runways >= 1200 m),
# 2% for code 1/2. Used as a clamp on the gradient fitted from the DEM, because
# what the DEM says across a 3 km strip is partly real slope and partly noise,
# and a runway steeper than this is not one.
GRADIENT_LIMIT_LONG = 0.01
GRADIENT_LIMIT_SHORT = 0.02
GRADIENT_LIMIT_LENGTH_M = 1200.0

# Platform footprint margins, metres.
#
# The strip is ICAO's: a code 3/4 runway sits inside a graded area 150 m wide,
# 75 m either side of the centreline, and 60 m of it beyond each threshold.
# RESA adds another 90 m. Flattening the strip rather than just the pavement is
# what stops the ground falling away at the runway edge, which reads as a table
# standing on the terrain rather than as an airfield cut into it.
STRIP_HALF_WIDTH_M = 75.0
STRIP_OVERRUN_M = 150.0
PAD_FEATHER_M = 80.0

# A pad's half-extents are its *outer* edge, feather included, and the fully
# flattened core is what is left inside. So the feather is added to the strip
# rather than taken out of it.
#
# Taken out of it, an 80 m feather inside a 75 m strip half-width leaves a core
# of zero: the whole runway becomes a ramp with the graded height reached only
# along the centreline, and the pavement edge sits half way between the plane
# and the raw DEM. Measured at Tenerife Norte before the fix, not one vertex
# under either runway strip was fully flattened.

# DEM sample spacing across a platform. 30 m is roughly the SRTM 1 arcsec cell,
# so a finer grid would resample the same posts rather than learn anything.
SAMPLE_STEP_M = 30.0

# Rejection thresholds, all reported rather than silent.
MAX_WATER_FRACTION = 0.10
MIN_VALID_SAMPLE_FRACTION = 0.60
# Cut/fill the plane implies against the DEM. Past this the footprint is on a
# cliff, which means the OSM geometry and the DEM disagree about where the
# ground is - a void, a bad `ele`, or a runway drawn in the wrong place.
MAX_RESIDUAL_M = 60.0
# Below the hard limit but worth saying out loud: a real airfield on real
# terrain sits within a few metres of its own plane.
WARN_RESIDUAL_M = 15.0

# How far a runway's true bearing may sit from what its `ref` implies before
# the extraction is suspect.
#
# Two things are expected in that difference and neither is an error. `ref` is
# magnetic and the geometry is true, so declination is in it - 20 degrees in
# the far north, though under 15 across most inhabited latitudes. And a
# designator is rounded to whole tens, which adds up to 5 more. Page Municipal
# is 15/33 running 170 true: 11 degrees of Arizona declination and 9 of
# rounding, and entirely correct.
#
# What this is looking for is an axis read wrong, and that is off by 90 or 180,
# not by 25.
MAX_REF_DELTA_DEG = 25.0

# Airfields kept per baked area, unlimited by default: a real area has plenty
# of small grass strips and gliding clubs alongside its one international
# field, and dropping them by rank silently made "the airfields of this area"
# mean "the biggest few of them". `--per-area N` still caps it for anyone who
# wants a lighter bake.
DEFAULT_PER_AREA = None

# Fitting one airfield - sampling every pad's DEM points and least-squaring a
# plane through them - is pure Python per point and independent of every other
# airfield, the same shape of work the DEM and coast bakes already split
# across worker processes. It only pays off once the per-area cap above was
# removed: a handful of airfields is over before a process pool would even
# finish starting, but an unlimited area can now hold dozens.
DEFAULT_JOBS = max(1, (os.cpu_count() or 1) - 1)


# --- local metric frame -----------------------------------------------------

def metres_per_degree(lat_deg: float) -> Tuple[float, float]:
    """Metres per degree of latitude and of longitude at `lat_deg`.

    The standard WGS84 series. Good to well under a metre per kilometre, which
    over an airfield - a few km at most - makes a local tangent plane exact
    enough that a proper geodesic solver would be measuring its own rounding.
    """
    lat = math.radians(lat_deg)
    m_lat = (111132.92 - 559.82 * math.cos(2 * lat)
             + 1.175 * math.cos(4 * lat) - 0.0023 * math.cos(6 * lat))
    m_lon = (111412.84 * math.cos(lat) - 93.5 * math.cos(3 * lat)
             + 0.118 * math.cos(5 * lat))
    return m_lat, m_lon


class LocalFrame:
    """East/north metres about one reference point."""

    def __init__(self, lat: float, lon: float):
        self.lat0 = lat
        self.lon0 = lon
        self.m_lat, self.m_lon = metres_per_degree(lat)
        # Guard the poles, where a degree of longitude vanishes and the inverse
        # transform would divide by nearly zero.
        self.m_lon = self.m_lon if abs(self.m_lon) > 1.0 else 1.0

    def to_m(self, lon: float, lat: float) -> Tuple[float, float]:
        return ((lon - self.lon0) * self.m_lon, (lat - self.lat0) * self.m_lat)

    def to_lonlat(self, e: float, n: float) -> Tuple[float, float]:
        return (self.lon0 + e / self.m_lon, self.lat0 + n / self.m_lat)


def bearing_deg(east: float, north: float) -> float:
    """Compass bearing of a local direction vector, degrees clockwise from north."""
    return math.degrees(math.atan2(east, north)) % 360.0


def angle_delta_deg(a: float, b: float) -> float:
    """Signed smallest difference a - b, in (-180, 180]."""
    d = (a - b + 180.0) % 360.0 - 180.0
    return d + 360.0 if d <= -180.0 else d


def fit_axis(points: Sequence[Tuple[float, float]]) -> Tuple[Tuple[float, float], Tuple[float, float]]:
    """Centroid and principal direction of a set of local-metre points.

    A runway way is *usually* two nodes, and then this is just the line through
    them. It is not always: plenty are drawn with intermediate nodes that wander
    a metre or two off the centreline, and some runways are mapped as an area
    rather than a line. Taking the first and last node of those gives an axis
    tilted by however much the digitiser's hand shook; the principal axis of all
    of them does not care.
    """
    n = len(points)
    cx = sum(p[0] for p in points) / n
    cy = sum(p[1] for p in points) / n
    sxx = sxy = syy = 0.0
    for x, y in points:
        dx, dy = x - cx, y - cy
        sxx += dx * dx
        sxy += dx * dy
        syy += dy * dy
    # Principal eigenvector of the 2x2 symmetric scatter matrix, closed form.
    trace = sxx + syy
    det = sxx * syy - sxy * sxy
    lam = trace / 2.0 + math.sqrt(max(0.0, trace * trace / 4.0 - det))
    if abs(sxy) > 1e-9:
        vx, vy = lam - syy, sxy
    else:
        vx, vy = (1.0, 0.0) if sxx >= syy else (0.0, 1.0)
    norm = math.hypot(vx, vy) or 1.0
    return (cx, cy), (vx / norm, vy / norm)


def axis_extent(
    points: Sequence[Tuple[float, float]],
    centre: Tuple[float, float],
    direction: Tuple[float, float],
) -> Tuple[float, float, float, float]:
    """(min, max) projections along the axis and across it, relative to `centre`."""
    ax, ay = direction
    along = [(p[0] - centre[0]) * ax + (p[1] - centre[1]) * ay for p in points]
    across = [-(p[0] - centre[0]) * ay + (p[1] - centre[1]) * ax for p in points]
    return (min(along), max(along), min(across), max(across))


# --- runway designators -----------------------------------------------------

def parse_ref(ref: Optional[str]) -> List[str]:
    """Split an OSM runway `ref` into its designators: '03L/21R' -> ['03L','21R']."""
    if not ref:
        return []
    parts = [p.strip().upper() for p in str(ref).replace('-', '/').split('/')]
    return [p for p in parts if p and p[0].isdigit()]


def designator_bearing(designator: str) -> Optional[float]:
    """Magnetic bearing a designator stands for: '03L' -> 30, '36' -> 360 -> 0."""
    digits = ''
    for ch in designator:
        if ch.isdigit():
            digits += ch
        else:
            break
    if not digits:
        return None
    number = int(digits)
    if not 1 <= number <= 36:
        return None
    return (number * 10.0) % 360.0


def designator_for(bearing: float) -> str:
    """The designator a true bearing would be painted with, if it were magnetic."""
    number = int(round(bearing / 10.0)) % 36
    return f'{(number if number else 36):02d}'


# --- extracted geometry -----------------------------------------------------

@dataclass
class Runway:
    ref: str
    heading_deg: float
    length_m: float
    width_m: float
    surface: str
    lit: bool
    lat: float
    lon: float
    thresholds: List[List[float]]
    osm_id: int
    #: True when `ref` was derived from the geometry because OSM had none.
    ref_derived: bool
    #: True bearing minus what `ref` implies. Mostly magnetic declination.
    ref_delta_deg: Optional[float]
    #: True when the runway was mapped as an area and the width is measured.
    width_measured: bool
    #: OSM's own `length` tag, where it has one. Not used for placement - the
    #: geometry is where the runway is - but a large disagreement means the way
    #: stops short of the declared distance, which is worth seeing.
    length_tag_m: Optional[float]
    #: True when OSM's `width` was too narrow to believe and the class default
    #: was used instead.
    width_implausible: bool


@dataclass
class Airfield:
    name: str
    icao: str
    iata: str
    kind: str
    lat: float
    lon: float
    ele_tag_m: Optional[float]
    osm_id: int
    runways: List[Runway] = field(default_factory=list)
    taxiways: List[dict] = field(default_factory=list)
    aprons: List[dict] = field(default_factory=list)
    buildings: List[dict] = field(default_factory=list)
    #: Displaced thresholds, blast pads and stopways - real pavement that is
    #: not a landing surface of its own, kept as ready-made pad rectangles
    #: rather than as `Runway`s. See `pavement_pad`.
    extra_pads: List[dict] = field(default_factory=list)
    #: Filled in by the DEM pass.
    plane: Optional[dict] = None
    fit: Optional[dict] = None
    pads: List[dict] = field(default_factory=list)
    area: str = ''

    @property
    def longest_m(self) -> float:
        return max((r.length_m for r in self.runways), default=0.0)


def aerodrome_kind(tags: dict) -> str:
    """Class of aerodrome, which is what sets the default runway width."""
    if tags.get('military') or tags.get('landuse') == 'military' \
            or tags.get('aerodrome:type') == 'military':
        return 'military'
    kind = tags.get('aerodrome:type') or tags.get('aerodrome')
    if kind in ('international', 'public', 'regional'):
        return 'international' if kind == 'international' else 'regional'
    if tags.get('icao') or tags.get('iata'):
        return 'regional'
    return 'ga'


def runway_surface(tags: dict) -> str:
    surface = str(tags.get('surface', '')).lower()
    if surface in ('asphalt', 'concrete', 'paved', 'concrete:plates'):
        return 'concrete' if surface.startswith('concrete') else 'asphalt'
    if surface in ('grass', 'ground', 'earth', 'dirt', 'sand', 'gravel', 'unpaved',
                   'compacted', 'fine_gravel'):
        return 'grass' if surface == 'grass' else 'gravel'
    return 'asphalt' if tags.get('ref') or tags.get('lit') == 'yes' else 'gravel'


# A storey, for turning `building:levels` into metres. Airport buildings run
# tall - a terminal concourse is one storey and fifteen metres of it - so this
# is the generous end of the usual 3-3.5 m.
STOREY_HEIGHT_M = 4.0


def building_height_m(tags: dict) -> Optional[float]:
    """Height in metres where OSM states one, else None.

    None is the common case by a mile: not one of Gran Canaria's sixty airport
    buildings carries a height or a storey count. The runtime infers one from
    the kind and the footprint, and this is here so that a better-mapped area
    is not held to the same guess.
    """
    height = tagged_number(tags.get('height') or tags.get('building:height'))
    if height is not None and height > 0:
        return height
    levels = tagged_number(tags.get('building:levels'))
    if levels is not None and levels > 0:
        return levels * STOREY_HEIGHT_M
    return None


def taxiway_width_m(tags: dict, kind: str) -> float:
    """A taxiway's width: OSM's own where it has one, else its class default."""
    tagged = tagged_width_m(tags)
    if tagged is not None and tagged >= MIN_PLAUSIBLE_TAXIWAY_WIDTH_M:
        return tagged
    return DEFAULT_TAXIWAY_WIDTH_M.get(kind, DEFAULT_TAXIWAY_WIDTH_M['ga'])


def min_plausible_width(length_m: float) -> float:
    """Narrowest a runway this long can be before the tag is disbelieved."""
    for threshold, width in MIN_PLAUSIBLE_WIDTH_M:
        if length_m >= threshold:
            return width
    return MIN_PLAUSIBLE_WIDTH_M[-1][1]


def same_runway(a: 'Runway', b: 'Runway') -> bool:
    """True when two ways describe one strip rather than a parallel pair.

    Perpendicular offset, not centre distance: two ways for the same runway sit
    on top of each other, while a parallel pair is at least 120 m apart across
    the axis however close their centres are along it.

    A stated pair of refs settles it outright. 03L and 03R are two runways no
    matter how the geometry landed, and merging them would delete one.
    """
    if abs(angle_delta_deg(a.heading_deg % 180.0, b.heading_deg % 180.0)) > DUPLICATE_HEADING_DEG:
        return False
    if a.ref and b.ref and a.ref != b.ref and not (a.ref_derived or b.ref_derived):
        return False
    frame = LocalFrame(a.lat, a.lon)
    e, n = frame.to_m(b.lon, b.lat)
    ax = math.sin(math.radians(a.heading_deg))
    ay = math.cos(math.radians(a.heading_deg))
    return abs(-e * ay + n * ax) < DUPLICATE_OFFSET_M


def dedupe_runways(runways: Sequence['Runway']) -> List['Runway']:
    """One entry per strip, preferring the way that measured its own width."""
    kept: List['Runway'] = []
    for runway in sorted(runways, key=lambda r: (not r.width_measured, -r.length_m)):
        if any(same_runway(runway, k) for k in kept):
            continue
        kept.append(runway)
    return kept


def runway_from_way(
    way: dict,
    nodes: Dict[int, Tuple[float, float]],
    kind: str,
) -> Optional[Runway]:
    """One `aeroway=runway` way as a centre, a heading, a length and a width.

    Handles both forms OSM uses. A centreline gets its width from tags or from
    the aerodrome class; a runway mapped as an area gets it measured off the
    polygon, which is better than either.
    """
    coords = [nodes[nid] for nid in way.get('nodes', []) if nid in nodes]
    if len(coords) < 2:
        return None
    tags = way.get('tags', {}) or {}
    # A displaced threshold, blast pad or stopway is mapped as its own
    # `aeroway=runway` way alongside the real one - not a landing surface with
    # its own designator, so turning it into a `Runway` would be a second,
    # often coincident, strip. The caller still keeps its pavement: see
    # `pavement_pad`, which is what `assemble_airfields` sends these to
    # instead of here.
    if tags.get('runway') in ('displaced_threshold', 'blast_pad', 'stopway'):
        return None
    lon0 = sum(c[0] for c in coords) / len(coords)
    lat0 = sum(c[1] for c in coords) / len(coords)
    frame = LocalFrame(lat0, lon0)
    pts = [frame.to_m(lon, lat) for lon, lat in coords]

    closed = len(coords) >= 4 and coords[0] == coords[-1]
    if closed:
        # A closed ring repeats its first node; leaving it in double-weights
        # that corner in the centroid the axis is fitted about.
        pts = pts[:-1]
    centre_m, direction = fit_axis(pts)
    a_min, a_max, c_min, c_max = axis_extent(pts, centre_m, direction)

    length = a_max - a_min
    if length < MIN_RUNWAY_LENGTH_M:
        return None

    measured_width = c_max - c_min
    width_measured = closed and measured_width > 5.0
    default_width = DEFAULT_RUNWAY_WIDTH_M.get(kind, DEFAULT_RUNWAY_WIDTH_M['ga'])
    width_implausible = False
    if width_measured:
        width = measured_width
    else:
        width = tagged_width_m(tags) or default_width
        if width < min_plausible_width(length):
            width = default_width
            width_implausible = True

    # Re-centre on the midpoint of the extent rather than on the centroid: an
    # unevenly noded way pulls its centroid toward the crowded end, and the
    # runway centre is the point halfway between the thresholds.
    mid = ((a_min + a_max) / 2.0)
    cx = centre_m[0] + direction[0] * mid
    cy = centre_m[1] + direction[1] * mid

    heading = bearing_deg(direction[0], direction[1])
    designators = parse_ref(tags.get('ref'))
    delta: Optional[float] = None
    if designators:
        want = designator_bearing(designators[0])
        if want is not None:
            # PCA hands back an axis, not an arrow: the sign is arbitrary. Point
            # it the way the first designator says, so 03/21 always runs 03 to
            # 21 and the thresholds come out in the order the ref names them.
            if abs(angle_delta_deg(heading, want)) > 90.0:
                direction = (-direction[0], -direction[1])
                heading = bearing_deg(direction[0], direction[1])
            delta = angle_delta_deg(heading, want)
        ref = '/'.join(designators)
        derived = False
    else:
        low = designator_for(heading)
        high = designator_for((heading + 180.0) % 360.0)
        ref = f'{low}/{high}'
        derived = True

    half = length / 2.0
    lon_c, lat_c = frame.to_lonlat(cx, cy)
    lon_a, lat_a = frame.to_lonlat(cx - direction[0] * half, cy - direction[1] * half)
    lon_b, lat_b = frame.to_lonlat(cx + direction[0] * half, cy + direction[1] * half)

    return Runway(
        ref=ref,
        heading_deg=heading,
        length_m=length,
        width_m=width,
        surface=runway_surface(tags),
        lit=str(tags.get('lit', '')).lower() == 'yes',
        lat=lat_c,
        lon=lon_c,
        thresholds=[[lat_a, lon_a], [lat_b, lon_b]],
        osm_id=int(way.get('id', 0)),
        ref_derived=derived,
        ref_delta_deg=delta,
        width_measured=width_measured,
        length_tag_m=tagged_number(tags.get('length')),
        width_implausible=width_implausible,
    )


def pavement_pad(
    way: dict,
    nodes: Dict[int, Tuple[float, float]],
    default_width: float,
) -> Optional[dict]:
    """A displaced threshold, blast pad or stopway as a flatten pad of its own.

    `runway_from_way` turns these away rather than double them up as landing
    strips, but they are still real pavement - Holzdorf's displaced threshold
    is hundreds of metres of concrete beyond where the runway way itself ends,
    and left unpadded that is a slab of the airfield perimeter the terrain
    never gets flattened or painted under. No ICAO strip overrun here: unlike
    a runway there is no regulatory graded area implied, just the mapped
    pavement plus the usual pad feather.
    """
    coords = [nodes[nid] for nid in way.get('nodes', []) if nid in nodes]
    if len(coords) < 2:
        return None
    tags = way.get('tags', {}) or {}
    lon0 = sum(c[0] for c in coords) / len(coords)
    lat0 = sum(c[1] for c in coords) / len(coords)
    frame = LocalFrame(lat0, lon0)
    pts = [frame.to_m(lon, lat) for lon, lat in coords]

    closed = len(coords) >= 4 and coords[0] == coords[-1]
    if closed:
        pts = pts[:-1]
    centre_m, direction = fit_axis(pts)
    a_min, a_max, c_min, c_max = axis_extent(pts, centre_m, direction)

    length = a_max - a_min
    if length <= 0.0:
        return None
    measured_width = c_max - c_min
    width = measured_width if closed and measured_width > 5.0 else (
        tagged_width_m(tags) or default_width)

    mid = (a_min + a_max) / 2.0
    cx = centre_m[0] + direction[0] * mid
    cy = centre_m[1] + direction[1] * mid
    lon_c, lat_c = frame.to_lonlat(cx, cy)

    return {
        'lat': lat_c,
        'lon': lon_c,
        'headingDeg': bearing_deg(direction[0], direction[1]),
        'halfD': length / 2.0 + PAD_FEATHER_M,
        'halfW': max(width / 2.0, MIN_PLAUSIBLE_TAXIWAY_WIDTH_M) + PAD_FEATHER_M,
        'featherM': PAD_FEATHER_M,
    }


def _ring_of(way: dict, nodes: Dict[int, Tuple[float, float]]) -> Optional[List[Tuple[float, float]]]:
    coords = [nodes[nid] for nid in way.get('nodes', []) if nid in nodes]
    if len(coords) < 4 or coords[0] != coords[-1]:
        return None
    return coords


def _oriented_footprint(
    ring: Sequence[Tuple[float, float]],
) -> Tuple[float, float, float, float, float]:
    """(lat, lon, headingDeg, widthM, depthM) of a building ring's long axis."""
    lon0 = sum(c[0] for c in ring) / len(ring)
    lat0 = sum(c[1] for c in ring) / len(ring)
    frame = LocalFrame(lat0, lon0)
    pts = [frame.to_m(lon, lat) for lon, lat in ring[:-1]]
    centre, direction = fit_axis(pts)
    a_min, a_max, c_min, c_max = axis_extent(pts, centre, direction)
    cx = centre[0] + direction[0] * (a_min + a_max) / 2.0 - direction[1] * (c_min + c_max) / 2.0
    cy = centre[1] + direction[1] * (a_min + a_max) / 2.0 + direction[0] * (c_min + c_max) / 2.0
    lon_c, lat_c = frame.to_lonlat(cx, cy)
    return (lat_c, lon_c, bearing_deg(*direction), c_max - c_min, a_max - a_min)


# --- Overpass ---------------------------------------------------------------

# --- progress ---------------------------------------------------------------

PhaseProgress = Callable[[float, str], None]
"""(fraction of the current phase done, 0..1; a short detail such as `12/40`)."""

# The bytes a fetch has received, turned into a guess at how far along it is:
# Overpass sends no Content-Length, so this is an asymptote that keeps the bar
# moving and never reaches the end before the answer does. 2 MB is about half
# of a regional taxiways-and-aprons answer; the aerodrome and runway answers
# are far smaller and simply arrive.
FETCH_HALFWAY_BYTES = 2 * 1024 * 1024


def fetch_fraction(received: int) -> float:
    return received / (received + FETCH_HALFWAY_BYTES)


def format_mb(n: int) -> str:
    return f'{n / (1024 * 1024):.1f} MB'


class StageProgress:
    """Whole-stage progress for the in-app importer, across weighted phases.

    A copy of the coast bake's class of the same name: tools/areaImport.ts
    reads `(NN.N% of stage)` off the end of a line as this stage's own
    percentage and shows it in the import dialog. Every phase is a weighted
    slice of the whole, so the percentage moves through the four Overpass
    fetches and the assembly too - the minutes that used to sit at 0% with
    nothing in the log.

    A phase that turns out not to apply (an optional fetch that failed, the
    write of a dry run) is skipped and its weight dropped, so the percentage
    still reaches 100 and only ever moves forward. The phase numbering stays
    over the full list, so `phase 6/8 ... skipped` reads as what it is.
    """

    def __init__(self, phases: Sequence[Tuple[str, str, float]], min_interval_s: float = 0.5):
        self._phases = [(key, label, float(weight)) for key, label, weight in phases]
        self._index = {key: i for i, (key, _l, _w) in enumerate(self._phases)}
        self._done: Set[str] = set()
        self._skipped: Set[str] = set()
        self._current: Optional[str] = None
        self._label = ''
        self._fraction = 0.0
        self._phase_started = 0.0
        self._last_print = 0.0
        self._min_interval = min_interval_s

    def _weight(self, key: str) -> float:
        return self._phases[self._index[key]][2]

    def percent(self) -> float:
        active = sum(w for k, _l, w in self._phases if k not in self._skipped)
        if active <= 0:
            return 100.0
        done = sum(self._weight(k) for k in self._done)
        if self._current is not None and self._current not in self._done:
            done += self._fraction * self._weight(self._current)
        return max(0.0, min(100.0, 100.0 * done / active))

    def _heading(self, key: str, label: str) -> str:
        return f'phase {self._index[key] + 1}/{len(self._phases)}  {label}'

    def is_done(self, key: str) -> bool:
        return key in self._done

    def begin(self, key: str, label: Optional[str] = None) -> None:
        if self._current is not None and self._current not in self._done:
            self.end()
        self._current = key
        self._label = label or self._phases[self._index[key]][1]
        self._fraction = 0.0
        self._phase_started = time.monotonic()
        self._last_print = 0.0
        print(self._heading(key, self._label), flush=True)

    def update(self, fraction: float, detail: str = '', force: bool = False) -> None:
        """Report where the current phase is. Throttled to keep the log sane."""
        self._fraction = max(self._fraction, max(0.0, min(1.0, fraction)))
        now = time.monotonic()
        if not force and fraction < 1.0 and now - self._last_print < self._min_interval:
            return
        self._last_print = now
        tail = f' {detail}' if detail else ''
        print(f'  {self._label}{tail}  ({self.percent():.1f}% of stage)', flush=True)

    def skip(self, key: str, reason: str) -> None:
        """Drop a phase from the total. Also the way out of a phase that was
        begun and then failed (an optional fetch the mirror refused): it is
        neither done nor still running afterwards."""
        self._skipped.add(key)
        if self._current == key:
            self._current = None
        print(f'{self._heading(key, self._phases[self._index[key]][1])} - skipped, {reason}',
              flush=True)

    def end(self, summary: str = '') -> None:
        if self._current is None:
            return
        self.update(1.0, force=True)
        self._done.add(self._current)
        elapsed = time.monotonic() - self._phase_started
        tail = f', {summary}' if summary else ''
        print(f'  {self._label} done in {elapsed:.1f}s{tail}', flush=True)
        self._current = None


# The phases one area goes through, in order, with their share of the stage.
# The fetches dominate on a cold cache and vanish on a warm one; the platform
# sampling is the CPU-bound part that remains. Keys are prefixed per area in
# `bake()` so a multi-area run numbers every phase of every area.
AREA_PHASES: Tuple[Tuple[str, str, float], ...] = (
    ('aerodromes', 'fetching OSM aerodromes', 3),
    ('runways', 'fetching OSM runways', 3),
    ('taxiways', 'fetching OSM taxiways', 6),
    ('aprons', 'fetching OSM aprons and buildings', 6),
    ('assemble', 'assembling airfields', 4),
    ('sample', 'sampling platforms', 20),
)


# --- Overpass ---------------------------------------------------------------

def _aeroway_query(clauses: Sequence[str]) -> str:
    body = '\n'.join(f'  {c};' for c in clauses)
    return f"""[out:json][timeout:180];
(
{body}
);
out body;
>;
out skel qt;
"""


def overpass_airports(
    b: Bounds, refresh: bool = False,
    progress: Optional[StageProgress] = None, phase_prefix: str = '',
) -> dict:
    """Aerodromes, runways and the rest of the surfaces, as separate requests.

    Separate, for the reason the coast bake documents at length: Overpass
    quietly returns fewer elements when one query asks for everything, and a
    runway silently missing from an airfield is not a visible failure - it is
    an airfield that comes out with one runway instead of three.

    Split by exact tag value rather than by one `aeroway~"^(a|b|c)$"` regex,
    which is what the public endpoints actually refuse: a regex over a key this
    broad is a scan, and an area-sized box of it came back 500 from kumi and
    504 from overpass-api.de on every attempt.

    The first two are required. The third - taxiways, aprons, buildings - is
    bulk, an order of magnitude more elements than the runways, and is allowed
    to fail: an airfield without its taxiways is still an airfield in the right
    place pointing the right way, and losing that to a busy endpoint would be
    the wrong trade.
    """
    box = b.as_overpass()
    aerodromes_query = _aeroway_query(
        [f'{kind}["aeroway"="aerodrome"]({box})'
         for kind in ('node', 'way', 'relation')])
    runways_query = _aeroway_query(
        [f'way["aeroway"="{kind}"]({box})' for kind in ('runway', 'helipad')])
    optional = (
        ('taxiways', 'taxiways', _aeroway_query([f'way["aeroway"="taxiway"]({box})'])),
        ('aprons', 'aprons and buildings', _aeroway_query(
            [f'way["aeroway"="{kind}"]({box})'
             for kind in ('apron', 'terminal', 'hangar', 'control_tower', 'tower')]
            + [f'relation["aeroway"="{kind}"]({box})'
               for kind in ('apron', 'terminal')])),
    )

    def fetch(key: str, label: str, query: str, **extra) -> List[dict]:
        """One fetch as one progress phase, bytes streaming into the bar."""
        if progress is not None:
            progress.begin(phase_prefix + key)

            def on_bytes(received: int) -> None:
                progress.update(fetch_fraction(received), f'{format_mb(received)} received')
            extra['on_progress'] = on_bytes
        got = overpass_fetch(query, label, refresh, **extra).get('elements', [])
        if progress is not None:
            progress.end(f'{len(got)} elements')
        return got

    elements: List[dict] = []
    # An empty aerodromes answer is checked on a second mirror before it is
    # believed: a silently truncated HTTP 200 looks exactly like a box with
    # no airfields, and one such answer was cached for Crimea and baked as
    # "no airfields" - it also disarms the empty check on the three fetches
    # below, which take the aerodrome count as their reference.
    aerodrome_elements = fetch('aerodromes', 'aerodromes', aerodromes_query,
                               validate=accept_empty_once())
    elements.extend(aerodrome_elements)

    def reject_if_suspiciously_empty(label: str, data: dict) -> None:
        # A bbox with aerodromes and zero elements from another aeroway query
        # over the same box is what overpass.osm.ch answers - HTTP 200, no
        # remark - when it silently truncates the query instead of failing
        # it, and a bbox with hundreds of aerodromes (this one has 2208
        # elements' worth, including Berlin Brandenburg Airport) coming back
        # with not one single taxiway or apron anywhere is that, not a
        # genuinely bare region. A bbox that has no aerodromes at all never
        # reaches here, since `aerodrome_elements` would itself be empty and
        # there would be nothing left to validate.
        if aerodrome_elements and not data.get('elements'):
            raise RuntimeError(
                f'{label} came back empty for a bbox with aerodromes - '
                'likely a truncated answer, not a bbox with none')

    # The runways and the two optional groups only need the aerodromes for
    # their empty-answer check, so they go out together, a couple at a time
    # (OVERPASS_CONCURRENCY), instead of one after another. The progress
    # bar shows them as one phase: the runways one carries the streamed
    # bytes of all three, and the other two complete the moment it ends.
    remaining = (('runways', 'runways', runways_query, False),) + tuple(
        (key, label, query, True) for key, label, query in optional)
    received = [0] * len(remaining)
    if progress is not None:
        progress.begin(phase_prefix + 'runways', 'fetching OSM runways, taxiways and aprons')

    def one(index: int) -> Tuple[Optional[List[dict]], Optional[Exception]]:
        key, label, query, _optional = remaining[index]
        extra: Dict[str, object] = {}
        if progress is not None:
            def on_bytes(n: int, index=index) -> None:
                received[index] = n
                total = sum(received)
                progress.update(fetch_fraction(total), f'{format_mb(total)} received')
            extra['on_progress'] = on_bytes
        try:
            data = overpass_fetch(
                query, label, refresh,
                validate=lambda data, label=label: reject_if_suspiciously_empty(label, data),
                **extra)
            return data.get('elements', []), None
        except Exception as err:  # reported below, per group
            return None, err

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=OVERPASS_CONCURRENCY) as pool:
        outcomes = list(pool.map(one, range(len(remaining))))

    counts = []
    for (key, label, _query, is_optional), (got, err) in zip(remaining, outcomes):
        if err is not None:
            if not is_optional:
                raise err
            print(f'  {label} unavailable ({err}) - baking without them', file=sys.stderr)
            if progress is not None:
                progress.skip(phase_prefix + key, 'unavailable, baking without them')
            continue
        elements.extend(got)
        counts.append(f'{len(got)} {label}')
        if progress is not None and key != 'runways':
            progress.begin(phase_prefix + key)
            progress.end(f'{len(got)} elements, fetched with the runways')
    if progress is not None:
        progress.end(', '.join(counts))
    return {'elements': elements}


# --- assembling airfields ---------------------------------------------------

def _polygon_of(element: dict, ways: Dict[int, dict], nodes: Dict[int, Tuple[float, float]]) -> Optional[Polygon]:
    if element.get('type') == 'way':
        ring = _ring_of(element, nodes)
        if ring is None:
            return None
        try:
            poly = Polygon(ring)
        except Exception:
            return None
        return poly if poly.is_valid and not poly.is_empty else poly.buffer(0) or None
    rings = relation_rings(element, ways, nodes)
    best: Optional[Polygon] = None
    for ring in rings:
        if len(ring) < 4:
            continue
        try:
            poly = Polygon(ring)
        except Exception:
            continue
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty:
            continue
        if best is None or poly.area > best.area:
            best = poly
    return best


class AerodromeIndex:
    """Which aerodrome an aeroway element belongs to, answered from two STRtrees.

    The plain scan this replaces tested every aerodrome polygon against every
    taxiway, apron and building - O(aerodromes x elements), and a regional
    box has hundreds of the one and tens of thousands of the other. The
    answer is unchanged:

    - a point inside an aerodrome polygon belongs to the first such aerodrome
      in OSM element order (the tree can return several for overlapping or
      nested polygons; the lowest index wins, as the scan's first hit did);
    - otherwise it belongs to the nearest node-only aerodrome within
      `ORPHAN_ASSIGN_RADIUS_M`, measured in that aerodrome's own local frame
      exactly as before, with the earlier of two equidistant nodes winning.

    The node tree holds each node's reach as a box in degrees - its radius
    converted through its own `LocalFrame`, so every node whose metric
    distance could be under the radius is a candidate, and the metric test
    then decides among the candidates precisely as the scan did.
    """

    def __init__(self, entries: Sequence[Tuple[Optional[Polygon], Airfield]]):
        self._entries = list(entries)
        poly_slots: List[int] = []
        poly_geoms: List[Polygon] = []
        node_slots: List[int] = []
        node_boxes: List[Polygon] = []
        self._node_frames: List[LocalFrame] = []
        for i, (poly, airfield) in enumerate(self._entries):
            if poly is not None:
                poly_slots.append(i)
                poly_geoms.append(poly)
                continue
            frame = LocalFrame(airfield.lat, airfield.lon)
            reach = ORPHAN_ASSIGN_RADIUS_M * 1.001
            west, south = frame.to_lonlat(-reach, -reach)
            east, north = frame.to_lonlat(reach, reach)
            node_slots.append(i)
            node_boxes.append(box(west, south, east, north))
            self._node_frames.append(frame)
        self._poly_slots = poly_slots
        self._node_slots = node_slots
        self._poly_tree = STRtree(poly_geoms) if poly_geoms else None
        self._node_tree = STRtree(node_boxes) if node_boxes else None

    def owner(self, lon: float, lat: float) -> Optional[Airfield]:
        """The aerodrome whose polygon holds this point, else the nearest node."""
        point = Point(lon, lat)
        if self._poly_tree is not None:
            hits = self._poly_tree.query(point, predicate='within')
            if len(hits):
                # Tree slots ascend with element order, so the lowest slot is
                # the scan's first hit.
                return self._entries[self._poly_slots[int(min(hits))]][1]
        best: Optional[Airfield] = None
        best_d = ORPHAN_ASSIGN_RADIUS_M
        if self._node_tree is not None:
            for slot in sorted(int(s) for s in self._node_tree.query(point)):
                e, n = self._node_frames[slot].to_m(lon, lat)
                d = math.hypot(e, n)
                if d < best_d:
                    best, best_d = self._entries[self._node_slots[slot]][1], d
        return best


def assemble_airfields(data: dict, on_progress: Optional[PhaseProgress] = None) -> List[Airfield]:
    """Group every aeroway element under the aerodrome it belongs to.

    `on_progress`, when given, hears (fraction, detail) as the elements are
    walked, for the importer's bar.
    """
    elements = data.get('elements', [])
    nodes = nodes_map(elements)
    ways = ways_map(elements)

    airfields: List[Airfield] = []
    polygons: List[Tuple[Optional[Polygon], Airfield]] = []

    for el in elements:
        tags = el.get('tags') or {}
        if tags.get('aeroway') != 'aerodrome':
            continue
        poly = None
        if el.get('type') in ('way', 'relation'):
            poly = _polygon_of(el, ways, nodes)
            if poly is None:
                continue
            lon, lat = poly.representative_point().x, poly.representative_point().y
        elif el.get('type') == 'node':
            lon, lat = el.get('lon'), el.get('lat')
            if lon is None or lat is None:
                continue
        else:
            continue
        ele = tagged_number(tags.get('ele'))
        airfield = Airfield(
            name=tags.get('name') or tags.get('icao') or f'aerodrome {el.get("id")}',
            icao=str(tags.get('icao', '')).upper(),
            iata=str(tags.get('iata', '')).upper(),
            kind=aerodrome_kind(tags),
            lat=float(lat),
            lon=float(lon),
            ele_tag_m=ele,
            osm_id=int(el.get('id', 0)),
        )
        airfields.append(airfield)
        polygons.append((poly, airfield))

    owner = AerodromeIndex(polygons).owner

    orphan_runways: List[Tuple[dict, Tuple[float, float]]] = []
    total = len(elements)

    for index, el in enumerate(elements):
        if on_progress is not None and index % 2000 == 0:
            on_progress(index / total if total else 1.0, f'{index}/{total} elements')
        tags = el.get('tags') or {}
        aeroway = tags.get('aeroway')
        if aeroway is None or aeroway == 'aerodrome':
            continue
        coords = [nodes[nid] for nid in el.get('nodes', []) if nid in nodes]             if el.get('type') == 'way' else []
        if not coords and el.get('type') == 'way':
            continue
        # Rings of a multipolygon, for the aeroways mapped as relations.
        #
        # Without this a relation reaches the `else` below and is dropped
        # without a word - the query asks Overpass for apron and terminal
        # relations and then threw every one of them away. Saki lost 2.7 ha of
        # ramp that way, which is what sent someone to the map to check.
        rel_rings: List[List[Tuple[float, float]]] = []
        if coords:
            lon = sum(c[0] for c in coords) / len(coords)
            lat = sum(c[1] for c in coords) / len(coords)
        elif el.get('type') == 'relation':
            rel_rings = [r for r in relation_rings(el, ways, nodes) if len(r) >= 4]
            if not rel_rings:
                continue
            flat = [p for r in rel_rings for p in r]
            lon = sum(p[0] for p in flat) / len(flat)
            lat = sum(p[1] for p in flat) / len(flat)
        elif el.get('type') == 'node':
            lon, lat = el.get('lon'), el.get('lat')
            if lon is None or lat is None:
                continue
        else:
            continue

        host = owner(lon, lat)
        if aeroway == 'runway':
            if host is None:
                orphan_runways.append((el, (lon, lat)))
                continue
            if tags.get('runway') in ('displaced_threshold', 'blast_pad', 'stopway'):
                default_width = DEFAULT_RUNWAY_WIDTH_M.get(host.kind, DEFAULT_RUNWAY_WIDTH_M['ga'])
                pad = pavement_pad(el, nodes, default_width)
                if pad is not None:
                    host.extra_pads.append(pad)
                continue
            runway = runway_from_way(el, nodes, host.kind)
            if runway is not None:
                host.runways.append(runway)
        elif host is None:
            continue
        elif aeroway == 'taxiway':
            host.taxiways.append({
                'widthM': taxiway_width_m(tags, host.kind),
                'points': [[c[1], c[0]] for c in coords],
            })
        elif aeroway == 'apron':
            # Every outer ring, not just the largest: a multipolygon apron with
            # two of them is two pieces of ramp, and keeping one leaves a hole
            # in the middle of an airfield.
            rings = list(rel_rings)
            if not rings:
                way_ring = _ring_of(el, nodes)
                if way_ring is not None:
                    rings = [way_ring]
            for ring in rings:
                host.aprons.append({'ring': [[c[1], c[0]] for c in ring]})
        elif aeroway in ('terminal', 'hangar', 'control_tower', 'tower'):
            ring = _ring_of(el, nodes) if el.get('type') == 'way' else (
                rel_rings[0] if rel_rings else None)
            if ring is None:
                continue
            lat_c, lon_c, heading, width, depth = _oriented_footprint(ring)
            host.buildings.append({
                'kind': 'tower' if aeroway in ('control_tower', 'tower') else aeroway,
                'lat': lat_c, 'lon': lon_c, 'headingDeg': heading,
                'widthM': width, 'depthM': depth,
                'heightM': building_height_m(tags),
            })

    # A runway inside no aerodrome at all is its own field. Disused strips and
    # farm airfields are mapped this way constantly, and dropping them would
    # quietly lose real places rather than fail.
    for el, (lon, lat) in orphan_runways:
        tags = el.get('tags') or {}
        synthetic = Airfield(
            name=tags.get('name') or f'airstrip {el.get("id")}',
            icao='', iata='', kind='ga',
            lat=float(lat), lon=float(lon), ele_tag_m=None,
            osm_id=int(el.get('id', 0)),
        )
        runway = runway_from_way(el, nodes, 'ga')
        if runway is None:
            continue
        synthetic.runways.append(runway)
        airfields.append(synthetic)

    for airfield in airfields:
        airfield.runways = dedupe_runways(airfield.runways)
    return [a for a in airfields if a.runways]


def tagged_number(raw) -> Optional[float]:
    if raw is None:
        return None
    text = str(raw).strip().replace(',', '.')
    number = ''
    for ch in text:
        if ch.isdigit() or ch in '.-':
            number += ch
        else:
            break
    try:
        return float(number)
    except ValueError:
        return None


# --- ranking ----------------------------------------------------------------

KIND_RANK = {'international': 3, 'military': 2, 'regional': 1, 'ga': 0}


def score(airfield: Airfield) -> Tuple:
    """Sort key, best first. Class, then a hard surface, then sheer length."""
    paved = any(r.surface in ('asphalt', 'concrete') for r in airfield.runways)
    return (
        -KIND_RANK.get(airfield.kind, 0),
        0 if paved else 1,
        0 if airfield.icao else 1,
        -airfield.longest_m,
        airfield.name,
    )


# --- terrain fit ------------------------------------------------------------

class LandMask:
    """Land/water lookups into the .lwm masks the coast bake wrote."""

    def __init__(self, out_dir: str, zoom: int, tile_size: int):
        self.out_dir = out_dir
        self.zoom = zoom
        self.n = tile_size
        self.span = 180.0 / (1 << zoom)
        # Least-recently-used, capped: an airfield's samples straddle a few
        # tiles and keep coming back to them, and dropping the whole cache
        # at the cap (as this used to) re-read every one of those from disk
        # right when they were all in play.
        self._cache: 'OrderedDict[Tuple[int, int], Optional[bytearray]]' = OrderedDict()
        self._cache_cap = 256

    def is_land(self, lon: float, lat: float) -> Optional[bool]:
        """True/False, or None where no mask was ever baked for this point."""
        x = int(math.floor((lon + 180.0) / self.span))
        y = int(math.floor((90.0 - lat) / self.span))
        key = (x, y)
        if key in self._cache:
            self._cache.move_to_end(key)
        else:
            self._cache[key] = read_lwm(self.out_dir, self.zoom, x, y)
            while len(self._cache) > self._cache_cap:
                self._cache.popitem(last=False)
        grid = self._cache[key]
        if grid is None:
            return None
        b = tile_bounds(self.zoom, x, y)
        cells = self.n - 1
        col = min(cells, max(0, int(round((lon - b.west) / (b.east - b.west) * cells))))
        row = min(cells, max(0, int(round((b.north - lat) / (b.north - b.south) * cells))))
        return grid[row * self.n + col] == LAND


def gradient_limit(length_m: float) -> float:
    """ICAO longitudinal slope limit for a runway of this length."""
    return GRADIENT_LIMIT_LONG if length_m >= GRADIENT_LIMIT_LENGTH_M else GRADIENT_LIMIT_SHORT


# Share of samples the high tail may be trimmed down to per pass, and how many
# passes. See :func:`fit_plane` for what is being trimmed and why.
TRIM_KEEP_QUANTILE = 0.90
TRIM_PASSES = 2
TRIM_FLOOR_FRACTION = 0.5


def fit_plane(samples: Sequence[Tuple[float, float]], limit: float) -> dict:
    """Least-squares ``h = a + b * along`` over the platform, gradient clamped.

    Only along the runway axis. A real runway also has a transverse camber, but
    it is ~1.5% over 45 m - a third of a metre, well under one DEM post - so
    fitting it would be fitting noise and calling it drainage.

    Clamping rather than rejecting a steep fit, because the fit is measuring two
    things at once: the ground's real slope and the DEM's error over it. ICAO
    says the first cannot exceed the limit, so anything past it is the second.

    The high tail is trimmed between passes because SRTM is a *surface* model,
    not a terrain one: it has the terminal roofs, the hangars and the trees in
    it, and an airport is exactly the place where those are large, numerous and
    all on one side of the ground. Measured at Gran Canaria, whose platform
    carries 59 mapped buildings, the untrimmed fit sat 8 m under the OSM
    elevation with 28 m of apparent cut; trimming leaves the plane on the
    ground and reports the buildings separately as `outlierMaxM`.

    One-sided, and only the high tail, because that is the direction the error
    has. A hangar stands above the apron; nothing on an airfield is a 20 m pit.
    """
    if len(samples) < 8:
        return {}
    along_all = np.array([s[0] for s in samples], dtype=np.float64)
    height_all = np.array([s[1] for s in samples], dtype=np.float64)

    def solve(along, height):
        design = np.column_stack([np.ones_like(along), along])
        (a, b), *_ = np.linalg.lstsq(design, height, rcond=None)
        return float(a), float(b)

    along, height = along_all, height_all
    a, raw = solve(along, height)
    floor = max(8, int(len(samples) * TRIM_FLOOR_FRACTION))
    for _ in range(TRIM_PASSES):
        residual = height - (a + raw * along)
        cut = float(np.quantile(residual, TRIM_KEEP_QUANTILE))
        keep = residual <= cut
        if int(keep.sum()) < floor:
            break
        along, height = along[keep], height[keep]
        a, raw = solve(along, height)

    clamped = max(-limit, min(limit, raw))
    if clamped != raw:
        # Re-solve the intercept against the gradient actually being used, or
        # the plane keeps the tilted fit's intercept and sits offset from the
        # ground by half the correction at both ends.
        a = float(np.mean(height - clamped * along))
    residual = height - (a + clamped * along)
    over_all = height_all - (a + clamped * along_all)
    return {
        'heightMsl': float(a),
        'gradient': float(clamped),
        'gradientRaw': raw,
        'clamped': clamped != raw,
        'samples': int(len(along)),
        'samplesTrimmed': int(len(samples) - len(along)),
        'residualRmsM': float(np.sqrt(np.mean(residual ** 2))),
        'residualMaxM': float(np.max(np.abs(residual))),
        # The tallest thing standing on the platform, buildings included. Not a
        # fit error - the plane is not supposed to reach a terminal roof.
        'outlierMaxM': float(np.max(over_all)),
    }


def stamp_pad_planes(airfield: Airfield) -> None:
    """Write the airfield's one plane onto each of its pads.

    A pad record has to stand on its own: the mesh bake reads the flatten pads
    as a flat list and never learns which airfield a given one came from. So
    the plane fitted once for the whole platform is written onto every pad as
    the height at *that pad's* centre, plus the slope and the bearing it rises
    along - which stays the platform's bearing even on a pad turned to a
    crossing runway, because they are all cut to the same plane.

    The field names are the terrain manifest's rather than this file's, since
    that is what these become: `halfD` runs along the pad, `halfW` across it.
    """
    plane = airfield.plane
    if plane is None:
        return
    primary = max(airfield.runways, key=lambda r: r.length_m)
    frame = LocalFrame(primary.lat, primary.lon)
    ax = math.sin(math.radians(plane['headingDeg']))
    ay = math.cos(math.radians(plane['headingDeg']))
    for pad in airfield.pads:
        e, n = frame.to_m(pad['lon'], pad['lat'])
        pad['heightMsl'] = plane['heightMsl'] + plane['gradient'] * (e * ax + n * ay)
        pad['gradient'] = plane['gradient']
        pad['gradientHeadingDeg'] = plane['headingDeg']


def platform_pads(airfield: Airfield) -> List[dict]:
    """Oriented rectangles the terrain has to be cut flat under.

    One per runway, grown to the ICAO strip rather than to the pavement, plus a
    box around each apron and one for every displaced threshold, blast pad or
    stopway `pavement_pad` recorded. Every one of them is flattened to the
    same plane - fitted once for the airfield, not once per rectangle -
    because two rectangles fitted separately meet at a step, and a step
    across the taxiway between the apron and the runway is exactly where it
    would be seen.
    """
    pads: List[dict] = []
    for runway in airfield.runways:
        pads.append({
            'lat': runway.lat,
            'lon': runway.lon,
            'headingDeg': runway.heading_deg,
            'halfD': runway.length_m / 2.0 + STRIP_OVERRUN_M + PAD_FEATHER_M,
            'halfW': max(STRIP_HALF_WIDTH_M, runway.width_m / 2.0 + 30.0) + PAD_FEATHER_M,
            'featherM': PAD_FEATHER_M,
        })
    pads.extend(airfield.extra_pads)
    primary = max(airfield.runways, key=lambda r: r.length_m)
    apron_pads: List[Tuple[float, dict]] = []
    for apron in airfield.aprons:
        ring = [(p[1], p[0]) for p in apron['ring']]
        if len(ring) < 4:
            continue
        lon0 = sum(c[0] for c in ring) / len(ring)
        lat0 = sum(c[1] for c in ring) / len(ring)
        frame = LocalFrame(lat0, lon0)
        pts = [frame.to_m(lon, lat) for lon, lat in ring]
        # Aligned to the runway, not to the apron's own long axis: an apron is
        # an irregular blob and its principal axis swings with the shape, which
        # would tilt the pad against the runway it adjoins.
        ax = math.sin(math.radians(primary.heading_deg))
        ay = math.cos(math.radians(primary.heading_deg))
        along = [p[0] * ax + p[1] * ay for p in pts]
        across = [-p[0] * ay + p[1] * ax for p in pts]
        cx_a = (min(along) + max(along)) / 2.0
        cx_c = (min(across) + max(across)) / 2.0
        area = (max(along) - min(along)) * (max(across) - min(across))
        if area < MIN_APRON_AREA_M2:
            continue
        lon_c, lat_c = frame.to_lonlat(cx_a * ax - cx_c * ay, cx_a * ay + cx_c * ax)
        apron_pads.append((area, {
            'lat': lat_c,
            'lon': lon_c,
            'headingDeg': primary.heading_deg,
            'halfD': max(30.0, (max(along) - min(along)) / 2.0 + 20.0) + PAD_FEATHER_M,
            'halfW': max(30.0, (max(across) - min(across)) / 2.0 + 20.0) + PAD_FEATHER_M,
            'featherM': PAD_FEATHER_M,
        }))
    apron_pads.sort(key=lambda p: -p[0])
    pads.extend(pad for _, pad in apron_pads[:MAX_APRON_PADS])
    return pads


def sample_platform(
    airfield: Airfield,
    dem: DemSampler,
    mask: Optional[LandMask],
) -> Tuple[List[Tuple[float, float]], int, int, int]:
    """DEM samples across every pad, as (along-axis metres, height).

    Returns the samples plus the counts the rejection rules read: how many
    points were asked for, how many the DEM could answer, and how many the
    coast mask calls water.
    """
    primary = max(airfield.runways, key=lambda r: r.length_m)
    frame = LocalFrame(primary.lat, primary.lon)
    ax = math.sin(math.radians(primary.heading_deg))
    ay = math.cos(math.radians(primary.heading_deg))

    samples: List[Tuple[float, float]] = []
    asked = valid = water = 0
    for pad in airfield.pads:
        pe, pn = frame.to_m(pad['lon'], pad['lat'])
        px = math.sin(math.radians(pad['headingDeg']))
        py = math.cos(math.radians(pad['headingDeg']))
        steps_l = max(1, int(pad['halfD'] * 2 / SAMPLE_STEP_M))
        steps_w = max(1, int(pad['halfW'] * 2 / SAMPLE_STEP_M))
        for i in range(steps_l + 1):
            u = -pad['halfD'] + i * (2 * pad['halfD'] / steps_l)
            for j in range(steps_w + 1):
                v = -pad['halfW'] + j * (2 * pad['halfW'] / steps_w)
                e = pe + px * u - py * v
                n = pn + py * u + px * v
                lon, lat = frame.to_lonlat(e, n)
                asked += 1
                if mask is not None and mask.is_land(lon, lat) is False:
                    water += 1
                h = dem.sample(lon, lat)
                if math.isfinite(h):
                    valid += 1
                    samples.append((e * ax + n * ay, h))
    return samples, asked, valid, water


# --- manifest ---------------------------------------------------------------

def airfield_to_json(airfield: Airfield) -> dict:
    return {
        'name': airfield.name,
        'icao': airfield.icao,
        'iata': airfield.iata,
        'kind': airfield.kind,
        'area': airfield.area,
        'lat': airfield.lat,
        'lon': airfield.lon,
        'elevationM': airfield.plane['heightMsl'] if airfield.plane else 0.0,
        # What OSM says the elevation is, kept beside what the DEM fitted.
        # They disagree by a few metres everywhere, and which one is right is a
        # question for whoever reads this rather than for the bake.
        'eleTagM': airfield.ele_tag_m,
        'osmId': airfield.osm_id,
        'plane': airfield.plane,
        'fit': airfield.fit,
        'runways': [{
            'ref': r.ref,
            'headingDeg': r.heading_deg,
            'lengthM': r.length_m,
            'widthM': r.width_m,
            'surface': r.surface,
            'lit': r.lit,
            'lat': r.lat,
            'lon': r.lon,
            'thresholds': r.thresholds,
            'osmId': r.osm_id,
            'refDerived': r.ref_derived,
            'refDeltaDeg': r.ref_delta_deg,
            'widthMeasured': r.width_measured,
            'lengthTagM': r.length_tag_m,
            'widthImplausible': r.width_implausible,
        } for r in airfield.runways],
        'taxiways': airfield.taxiways,
        'aprons': airfield.aprons,
        'buildings': airfield.buildings,
        'pads': airfield.pads,
    }


def merge_items(previous: Sequence[dict], fresh: Sequence[dict], bbox: Bounds) -> List[dict]:
    """Fresh items inside the bbox, plus everything previously baked outside it.

    The same rule the coast bake follows for its tiles, for the same reason: a
    scoped bake looked at one box and knows nothing about the rest of the
    pyramid. Replacing the whole list would unbake every other area's airfields.
    """
    kept = [
        item for item in previous
        if not (bbox.west <= item.get('lon', 0.0) <= bbox.east
                and bbox.south <= item.get('lat', 0.0) <= bbox.north)
    ]
    return sorted(kept + list(fresh), key=lambda i: (i.get('icao') or 'ZZZZ', i.get('name', '')))


def union_bounds(previous: Optional[dict], b: Bounds) -> dict:
    if not previous:
        return {'west': b.west, 'south': b.south, 'east': b.east, 'north': b.north}
    return {
        'west': min(previous['west'], b.west),
        'south': min(previous['south'], b.south),
        'east': max(previous['east'], b.east),
        'north': max(previous['north'], b.north),
    }


# --- the bake ---------------------------------------------------------------

def area_bounds(manifest: dict) -> List[Tuple[str, Bounds]]:
    """Each named area as a box, or the whole coverage when none are recorded."""
    areas = manifest.get('areas') or []
    if areas:
        return [(a['name'], Bounds(a['west'], a['south'], a['east'], a['north']))
                for a in areas]
    cov = manifest.get('coverage', {})
    return [('terrain', Bounds(cov['west'], cov['south'], cov['east'], cov['north']))]


def bbox_area_name(manifest: dict, bbox: Bounds, tol: float = 1e-6) -> str:
    """The registered area an explicit --bbox belongs to, if any.

    An area baked by hand with --bbox used to be stamped with the literal
    name 'bbox' rather than the area it actually covers, which left every
    airfield inside it invisible at runtime: airfieldsInArea() filters by
    name, and nothing is ever called 'bbox'. Matching the box against the
    manifest's own areas (the common case: the caller copied its bounds
    from bake_planet_dem.py --name) keeps the name real; an unregistered
    box - genuine ad-hoc exploration - still falls back to 'bbox'.
    """
    for name, bounds in area_bounds(manifest):
        if (abs(bounds.west - bbox.west) < tol and abs(bounds.south - bbox.south) < tol
                and abs(bounds.east - bbox.east) < tol and abs(bounds.north - bbox.north) < tol):
            return name
    return 'bbox'


def report_airfield(airfield: Airfield, rejected: str = '') -> None:
    head = f'{airfield.icao or "----"}  {airfield.name}'
    if rejected:
        print(f'  SKIP {head}: {rejected}')
        return
    print(f'  {head}  [{airfield.kind}] {airfield.lat:.5f}, {airfield.lon:.5f}')
    for r in airfield.runways:
        delta = '' if r.ref_delta_deg is None else f' ref delta  {r.ref_delta_deg:+.1f} deg'
        flags = []
        if r.ref_derived:
            flags.append('ref derived')
        if r.width_measured:
            flags.append('width measured')
        if r.width_implausible:
            flags.append('OSM width too narrow to believe')
        note = f'  ({", ".join(flags)})' if flags else ''
        print(f'      {r.ref:9s} {r.length_m:6.0f} m x {r.width_m:4.1f} m  '
              f'{r.surface:8s} hdg {r.heading_deg:05.1f} deg{delta}{note}')
        if r.ref_delta_deg is not None and abs(r.ref_delta_deg) > MAX_REF_DELTA_DEG:
            # Declination plus the rounding to whole tens accounts for about
            # 15 degrees at worst. More than that and the axis was read wrong,
            # or OSM's ref belongs to a different runway.
            print(f'        warning: {r.ref} implies '
                  f'{designator_bearing(parse_ref(r.ref)[0]):.0f} deg magnetic, '
                  f'but the geometry runs {r.heading_deg:.1f} deg true')
        if r.length_tag_m is not None:
            gap = r.length_m - r.length_tag_m
            if abs(gap) > max(25.0, 0.02 * r.length_tag_m):
                print(f'        note: OSM length tag says {r.length_tag_m:.0f} m, '
                      f'the way measures {gap:+.0f} m against it')
    fit = airfield.fit or {}
    if fit:
        clamp = ' (clamped from %+.2f%%)' % (fit['gradientRaw'] * 100) if fit['clamped'] else ''
        print(f'      plane {fit["heightMsl"]:.1f} m MSL  '
              f'gradient {fit["gradient"] * 100:+.2f}%{clamp}  '
              f'residual rms {fit["residualRmsM"]:.1f} m max {fit["residualMaxM"]:.1f} m  '
              f'({fit["samples"]} samples, {fit["samplesTrimmed"]} trimmed, '
              f'tallest {fit["outlierMaxM"]:.0f} m above the plane)')
        if fit['residualMaxM'] > WARN_RESIDUAL_M:
            print(f'      note: {fit["residualMaxM"]:.0f} m of cut/fill - '
                  f'steep ground or a coarse DEM under this one')
    if airfield.ele_tag_m is not None and airfield.plane:
        drift = airfield.plane['heightMsl'] - airfield.ele_tag_m
        print(f'      OSM ele {airfield.ele_tag_m:.0f} m, DEM plane differs by {drift:+.1f} m')
    print(f'      {len(airfield.pads)} pads, {len(airfield.taxiways)} taxiways, '
          f'{len(airfield.aprons)} aprons, {len(airfield.buildings)} buildings')


def evaluate_airfield(
    airfield: Airfield, dem: DemSampler, mask: Optional[LandMask],
) -> Optional[dict]:
    """DEM-samples, fits and reports one airfield. None if it is rejected.

    Factored out of `bake()`'s per-area loop so a multiprocessing worker can
    call it too, one airfield per call - `airfield.pads` and `.area` must
    already be set (`bake()` does that before dispatch, cheap work that stays
    serial). Every candidate is independent of every other: nothing here reads
    or writes state another airfield's evaluation touches.
    """
    samples, asked, valid, water = sample_platform(airfield, dem, mask)
    if asked == 0 or valid / asked < MIN_VALID_SAMPLE_FRACTION:
        report_airfield(airfield, f'DEM covers {valid}/{asked} of the platform')
        return None
    if asked and water / asked > MAX_WATER_FRACTION:
        report_airfield(airfield, f'{100.0 * water / asked:.0f}% of the platform is water')
        return None
    longest = max(r.length_m for r in airfield.runways)
    fit = fit_plane(samples, gradient_limit(longest))
    if not fit:
        report_airfield(airfield, 'too few DEM samples to fit a plane')
        return None
    if fit['residualMaxM'] > MAX_RESIDUAL_M:
        report_airfield(
            airfield,
            f'{fit["residualMaxM"]:.0f} m of cut/fill - the DEM and OSM '
            f'disagree about where the ground is')
        return None
    airfield.fit = fit
    airfield.plane = {
        'heightMsl': fit['heightMsl'],
        'gradient': fit['gradient'],
        'headingDeg': max(airfield.runways, key=lambda r: r.length_m).heading_deg,
    }
    stamp_pad_planes(airfield)
    report_airfield(airfield)
    return airfield_to_json(airfield)


# Per-worker state for evaluate_airfields_parallel, set once by _init_airfield_worker.
# DemSampler/LandMask each hold an on-disk tile cache that is pointless to
# share across processes - and cannot be, a plain dict does not survive a
# spawn boundary - so every worker opens its own, the same trade
# `open_sampler` documents for the DEM bake's own worker pool.
_af_dem: Optional[DemSampler] = None
_af_mask: Optional[LandMask] = None


def _init_airfield_worker(out_dir: str, max_zoom: int, tile_size: int, has_mask: bool) -> None:
    global _af_dem, _af_mask
    _af_dem = DemSampler(out_dir, max_zoom, tile_size)
    _af_mask = LandMask(out_dir, max_zoom, tile_size) if has_mask else None


def _airfield_worker(airfield: Airfield) -> Tuple[Optional[dict], str]:
    """Runs `evaluate_airfield` with its prints captured, for the parent to
    replay in submission order - workers finish in whatever order the DEM
    happens to answer them, and interleaving several airfields' reports would
    read as garbage."""
    assert _af_dem is not None
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        result = evaluate_airfield(airfield, _af_dem, _af_mask)
    return result, buf.getvalue()


def evaluate_airfields_parallel(
    found: Sequence[Airfield],
    dem: DemSampler,
    mask: Optional[LandMask],
    out_dir: str,
    max_zoom: int,
    tile_size: int,
    jobs: int,
    on_progress: Optional[PhaseProgress] = None,
) -> List[dict]:
    """Evaluates every candidate in `found`, across `jobs` worker processes.

    Every candidate is evaluated - there is no cap to short-circuit against,
    which is what makes this worth pooling at all (see `bake()`: a finite
    `--per-area` keeps the serial early-break instead, since most of its
    candidates are never looked at).
    """
    def report(done: int) -> None:
        if on_progress is not None:
            on_progress(done / len(found) if found else 1.0, f'{done}/{len(found)}')

    jobs = max(1, min(jobs, len(found))) if found else 1
    kept: List[dict] = []
    if jobs == 1:
        for done, airfield in enumerate(found, 1):
            result = evaluate_airfield(airfield, dem, mask)
            if result is not None:
                kept.append(result)
            report(done)
        return kept

    ctx = mp.get_context('spawn')
    with ctx.Pool(
        jobs, initializer=_init_airfield_worker,
        initargs=(out_dir, max_zoom, tile_size, mask is not None),
    ) as pool:
        for done, (result, report_text) in enumerate(
                pool.imap(_airfield_worker, found, chunksize=4), 1):
            sys.stdout.write(report_text)
            if result is not None:
                kept.append(result)
            report(done)
    return kept


def bake(args: argparse.Namespace) -> int:
    started = time.time()
    manifest_path = args.manifest or os.path.join(args.out, 'manifest.json')
    if not os.path.isfile(manifest_path):
        print(f'error: manifest not found: {manifest_path}', file=sys.stderr)
        print('Run tools/bake_planet_dem.py first.', file=sys.stderr)
        return 2
    manifest = load_manifest(manifest_path)
    out_dir = args.out or os.path.dirname(manifest_path)
    tile_size = manifest.get('tileSize', 257)
    max_zoom = manifest.get('maxZoom', 12)

    if args.bbox:
        bbox = parse_bbox(args.bbox)
        targets = [(bbox_area_name(manifest, bbox), bbox)]
    else:
        targets = area_bounds(manifest)
    print(f'targets     {len(targets)}: ' + ', '.join(name for name, _ in targets))

    dem = DemSampler(out_dir, max_zoom, tile_size)
    mask = None
    if manifest.get('coastMask', {}).get('enabled'):
        mask = LandMask(out_dir, max_zoom, tile_size)
    else:
        print('            no coast mask baked - water rejection is off')

    block = manifest.get('airfields') or {}
    items: List[dict] = list(block.get('items') or [])
    coverage = block.get('coverage')

    # Every area's phases in order, then the one write at the end. With one
    # target (the importer's case) the prefix is empty and the headings read
    # `phase 1/7  fetching OSM aerodromes`; a multi-area run numbers through.
    def prefix_for(i: int) -> str:
        return '' if len(targets) == 1 else f'{i}:'
    phases: List[Tuple[str, str, float]] = []
    for i, (name, _b) in enumerate(targets):
        suffix = '' if len(targets) == 1 else f' ({name})'
        phases.extend((prefix_for(i) + key, label + suffix, weight)
                      for key, label, weight in AREA_PHASES)
    phases.append(('write', 'writing the manifest', 1))
    progress = StageProgress(phases)

    total_kept = 0
    fresh_ids: Set[int] = set()
    failed: List[str] = []
    for i, (name, bounds) in enumerate(targets):
        prefix = prefix_for(i)
        print(f'\narea {name}  lon [{bounds.west:.4f}, {bounds.east:.4f}] '
              f'lat [{bounds.south:.4f}, {bounds.north:.4f}]')
        try:
            data = overpass_airports(bounds, args.refresh_osm, progress, prefix)
        except Exception as err:
            # One area's fetch failing must not cost the areas after it. The
            # merge is per-bbox, so a skipped area simply keeps whatever it had
            # from an earlier run and the rest of this one still lands.
            print(f'  Overpass failed for {name}: {err} - skipping this area',
                  file=sys.stderr)
            failed.append(name)
            for key, _label, _weight in AREA_PHASES:
                if not progress.is_done(prefix + key):
                    progress.skip(prefix + key, 'Overpass failed for this area')
            continue
        print(f'  {len(data.get("elements", []))} OSM elements')
        progress.begin(prefix + 'assemble')
        found = assemble_airfields(data, progress.update)
        # Overpass returns anything *touching* the box; an airfield whose
        # polygon overlaps the edge but whose runways are outside belongs to
        # the neighbouring area, and claiming it here would place it twice.
        found = [a for a in found
                 if bounds.west <= a.lon <= bounds.east and bounds.south <= a.lat <= bounds.north]
        found.sort(key=score)
        cap = 'all' if args.per_area is None else f'up to {args.per_area}'
        progress.end(f'{len(found)} aerodromes with runways')
        print(f'  {len(found)} aerodromes with runways; keeping {cap}')

        for airfield in found:
            airfield.area = name
            airfield.pads = platform_pads(airfield)

        progress.begin(prefix + 'sample')
        if args.per_area is not None:
            # A finite cap is usually reached long before the end of a sorted
            # `found`, so the serial early-break - stop the moment enough are
            # kept - skips sampling candidates a pool would have spun up a
            # worker for nothing. Pooling only pays when every candidate gets
            # evaluated anyway, which is the (now default) uncapped case.
            kept: List[dict] = []
            for done, airfield in enumerate(found, 1):
                if len(kept) >= args.per_area:
                    break
                result = evaluate_airfield(airfield, dem, mask)
                if result is not None:
                    kept.append(result)
                progress.update(done / len(found), f'{done}/{len(found)}')
        else:
            t_af = time.time()
            kept = evaluate_airfields_parallel(
                found, dem, mask, out_dir, max_zoom, tile_size, args.jobs, progress.update)
            if len(found) > 1:
                print(f'  fitted {len(found)} candidates in {time.time() - t_af:.1f}s')
        progress.end(f'{len(kept)} kept')

        items = merge_items(items, kept, bounds)
        coverage = union_bounds(coverage, bounds)
        total_kept += len(kept)
        fresh_ids.update(i['osmId'] for i in kept)

    if args.dry_run:
        progress.skip('write', 'dry run')
        print(f'\ndry run - {total_kept} airfields, manifest not written')
        return 1 if failed else 0

    progress.begin('write')
    manifest['airfields'] = {
        'source': 'osm',
        'coverage': coverage,
        'items': items,
    }
    # No version bump: the block is additive and every existing reader ignores
    # what it does not know about. The mesh bake starts reading it in the next
    # step, and that is where a version means something.
    with open(manifest_path, 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=2)
        fh.write('\n')
    progress.end()

    runways = sum(len(i['runways']) for i in items)
    print(f'\nwrote {len(items)} airfields ({runways} runways) to {manifest_path}')
    # Counted against the manifest rather than against the loop: the areas
    # overlap, so an airfield sitting in two of them is baked twice and stored
    # once, and totalling the per-area counts would claim more than are there.
    carried = sum(1 for i in items if i['osmId'] not in fresh_ids)
    print(f'  {len(items) - carried} from this run '
          f'({total_kept} bakes across {len(targets)} areas), '
          f'{carried} carried from earlier bakes')
    if failed:
        print(f'  {len(failed)} areas skipped after an Overpass failure: '
              f'{", ".join(failed)} - re-run to pick them up')
    print(f'done in {time.time() - started:.1f}s')
    return 1 if failed else 0


def make_console_printable() -> None:
    """Never let an OSM name kill the bake.

    Names come straight out of OSM in whatever script the place uses, and a
    Windows console is cp1252: printing one character it cannot encode raises
    rather than degrading, and the run dies partway through the report with
    every airfield already computed. This is a report - it can afford to lose
    an accent, it cannot afford to lose the run.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors='backslashreplace')
        except Exception:
            pass


def main(argv: Optional[Iterable[str]] = None) -> int:
    make_console_printable()
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--manifest', help='planet manifest.json (default: {out}/manifest.json)')
    parser.add_argument('--out', default='assets/planet', help='planet asset directory')
    parser.add_argument('--bbox', help='west,south,east,north degrees (default: every baked area)')
    parser.add_argument('--per-area', type=int, default=DEFAULT_PER_AREA,
                        help='airfields kept per area, best first (default: unlimited)')
    parser.add_argument('--refresh-osm', action='store_true',
                        help='ignore the cached Overpass response and re-fetch')
    parser.add_argument('--jobs', type=int, default=DEFAULT_JOBS,
                        help=f'airfields fitted concurrently when --per-area is unset '
                             f'(default {DEFAULT_JOBS})')
    parser.add_argument('--dry-run', action='store_true',
                        help='report what would be baked without writing the manifest')
    raw = list(argv) if argv is not None else sys.argv[1:]
    args = parser.parse_args(glue_negative_bbox(raw))
    return bake(args)


if __name__ == '__main__':
    raise SystemExit(main())

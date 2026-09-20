"""Bridge and tunnel spans lifted out of the OSM road answer.

`bake_osm_roads.py` already fetches every highway way with its tags, so a
bridge needs no second Overpass query: it is a way carrying `bridge=*` (or
`tunnel=*`). This module picks those ways out, keeps each span on its own -
never chained into the road either side, so the bake can mask exactly that
stretch of the ground stroke - and reads what a procedural bridge needs:
structure, deck width, layer, clearance and length.

The output feeds `tools/bake/bridges.ts`, which drapes the abutments, raises
the deck and places the piers. Nothing here knows about terrain.
"""

from __future__ import annotations

import math
import struct
import zlib
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from osm_common import nodes_map, tagged_width_m, ways_map

RBR_MAGIC = b'RBR1'

# Structure byte, part of the format (tools/bake/bridges.ts holds the table).
STRUCTURES: Tuple[str, ...] = (
    'slab', 'beam', 'arch', 'truss', 'cable_stayed', 'suspension', 'floating', 'tunnel',
)
STRUCTURE_BYTE: Dict[str, int] = {name: i for i, name in enumerate(STRUCTURES)}

# `bridge:structure` / `bridge=*` values folded onto the table.
_TAGGED: Dict[str, str] = {
    'beam': 'beam', 'simple_supports': 'beam', 'girder': 'beam', 'box_girder': 'beam',
    'arch': 'arch', 'truss': 'truss', 'suspension': 'suspension',
    'cable-stayed': 'cable_stayed', 'cable_stayed': 'cable_stayed',
    'floating': 'floating', 'pontoon': 'floating',
}

# Spans shorter than this are a slab whatever the tags say.
SLAB_MAX_M = 40.0
# Longer untagged spans are a beam bridge: a viaduct on piers. Length says
# nothing about arch, truss or cable-stayed - a Stadtring viaduct is 900 m of
# plain beam - and a guess of cable-stayed leaves the whole span unsupported,
# so those come from the tags or not at all.

# Deck width when neither `width` nor `lanes` is tagged.
FALLBACK_DECK_M = 9.0
LANE_M = 3.5
# A carriageway's kerbs, parapets and verge on both sides.
DECK_MARGIN_M = 2.0

METRES_PER_DEGREE = 111320.0


@dataclass
class Bridge:
    structure: int
    deck_width_m: float
    layer: int
    # Tagged `maxheight`, metres, 0 = untagged. That is the limit for vehicles
    # ON the bridge, not the clearance under it, so the deck generator ignores
    # it; kept because a tunnel or a low truss portal is drawn from it.
    clearance_m: float
    points: List[Tuple[float, float]]

    @property
    def length_m(self) -> float:
        return polyline_length_m(self.points)


def polyline_length_m(points: Sequence[Tuple[float, float]]) -> float:
    total = 0.0
    for (lon0, lat0), (lon1, lat1) in zip(points, points[1:]):
        dx = (lon1 - lon0) * math.cos(math.radians((lat0 + lat1) / 2)) * METRES_PER_DEGREE
        dy = (lat1 - lat0) * METRES_PER_DEGREE
        total += math.hypot(dx, dy)
    return total


def _layer(tags: dict) -> int:
    try:
        return int(float(str(tags.get('layer', '0')).split(';')[0]))
    except ValueError:
        return 0


def _height_m(raw: Optional[str]) -> float:
    if not raw:
        return 0.0
    text = str(raw).strip().replace(',', '.')
    number = ''
    for ch in text:
        if ch.isdigit() or ch == '.':
            number += ch
        else:
            break
    try:
        return float(number)
    except ValueError:
        return 0.0


def classify_structure(tags: dict, length_m: float) -> int:
    """The structure byte: tagged if OSM says, else guessed from the span length."""
    if tags.get('tunnel') and tags.get('tunnel') != 'no':
        return STRUCTURE_BYTE['tunnel']
    for key in ('bridge:structure', 'bridge'):
        tagged = _TAGGED.get(str(tags.get(key, '')).lower())
        if tagged:
            return STRUCTURE_BYTE[tagged]
    if length_m < SLAB_MAX_M:
        return STRUCTURE_BYTE['slab']
    return STRUCTURE_BYTE['beam']


def deck_width_m(tags: dict) -> float:
    tagged = tagged_width_m(tags)
    if tagged is not None:
        return tagged + DECK_MARGIN_M
    lanes = tags.get('lanes')
    if lanes:
        try:
            count = float(str(lanes).split(';')[0])
            if count > 0:
                return count * LANE_M + DECK_MARGIN_M
        except ValueError:
            pass
    return FALLBACK_DECK_M


def is_span(tags: dict) -> bool:
    if not tags.get('highway'):
        return False
    bridge = tags.get('bridge')
    tunnel = tags.get('tunnel')
    return bool((bridge and bridge != 'no') or (tunnel and tunnel != 'no'))


def extract_bridges(data: dict) -> List[Bridge]:
    """Every bridge and tunnel span in an Overpass answer, one per way."""
    elements = data.get('elements', [])
    nodes = nodes_map(elements)
    out: List[Bridge] = []
    for way in ways_map(elements).values():
        tags = way.get('tags', {})
        if not is_span(tags):
            continue
        pts = [nodes[n] for n in way.get('nodes', []) if n in nodes]
        if len(pts) < 2:
            continue
        length = polyline_length_m(pts)
        out.append(Bridge(
            structure=classify_structure(tags, length),
            deck_width_m=deck_width_m(tags),
            layer=_layer(tags),
            clearance_m=_height_m(tags.get('maxheight')),
            points=[(float(lon), float(lat)) for lon, lat in pts],
        ))
    return out


def encode_rbr(bridges: Sequence[Bridge]) -> bytes:
    """RBR1: u16 count, per span u8 structure, i8 layer, f32 width, f32 clearance, u16 n, n x (f32 lon, f32 lat); zlib."""
    payload = bytearray(RBR_MAGIC)
    payload += struct.pack('<H', len(bridges))
    for b in bridges:
        payload += struct.pack('<Bbff H', b.structure, max(-128, min(127, b.layer)),
                               float(b.deck_width_m), float(b.clearance_m), len(b.points))
        for lon, lat in b.points:
            payload += struct.pack('<ff', float(lon), float(lat))
    return zlib.compress(bytes(payload), 6)


def decode_rbr(blob: bytes) -> List[Bridge]:
    payload = zlib.decompress(blob)
    if payload[:4] != RBR_MAGIC:
        raise ValueError('bad RBR magic')
    (count,) = struct.unpack_from('<H', payload, 4)
    off = 6
    head = struct.calcsize('<Bbff H')
    out: List[Bridge] = []
    for _ in range(count):
        structure, layer, width, clearance, n = struct.unpack_from('<Bbff H', payload, off)
        off += head
        pts = []
        for _p in range(n):
            pts.append(struct.unpack_from('<ff', payload, off))
            off += 8
        out.append(Bridge(structure, width, layer, clearance, [(a, b) for a, b in pts]))
    return out

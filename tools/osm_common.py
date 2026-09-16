#!/usr/bin/env python3
"""Plumbing shared by the OpenStreetMap bake stages.

Two stages now read OSM and the baked planet pyramid — ``bake_osm_coast.py``
for land, water and watercourses, ``bake_osm_airports.py`` for aerodromes —
and they need the same things: a tile grid, an Overpass client, the element
helpers that survive Overpass's ``out body; >; out skel qt;`` answer shape, and
readers for the ``.pdm`` heights and ``.lwm`` land mask already on disk.

Shared rather than copied, because the parts that matter here are the ones a
copy gets subtly wrong. The Overpass cache is keyed by query hash and lives in
one directory: two clients would mean two caches, and a stage re-fetching what
its neighbour already has is exactly what the cache exists to prevent. The tile
snapping is the rule that keeps two imported areas stitched together, and the
way-id de-duplication is a bug that cost a whole peninsula once already.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import pickle
import struct
import sys
import threading
import time
import zlib
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Set, Tuple

import numpy as np
import requests
from shapely.geometry import Polygon, box


# --- land/water mask -------------------------------------------------------

LWM_MAGIC = b'LWM1'
LWM_HEADER_BYTES = 8
LWM_NODATA = 255
LAND = 1
WATER = 0

# --- Overpass ---------------------------------------------------------

# Overpass responses are cached by query hash. The public endpoints refuse
# large queries often enough that without this a single 500 costs another full
# fetch, and a bake that fails at a later stage re-downloads everything.
OSM_CACHE_DIR = os.path.join('data', 'osm-cache')

# Planet mirrors only. overpass.osm.ch was in this list until 2026-09-16: it
# serves a Switzerland extract, not the planet, so every cell it answered
# came back cut at the Swiss border (an alps import baked the whole Italian
# side, Aosta included, with no land-use, no rivers and no lakes, while the
# Valais half of the same cell was complete). Nothing in the answer says so -
# HTTP 200, no remark, thousands of elements - so it cannot be guarded
# against per answer; it has to stay out of the rotation.
OVERPASS_URLS = (
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
)

# (connect, read). A mirror that is down outright - unreachable, or behind a
# network that blocks it - should fail in seconds, not eat the same 300s a
# reachable-but-slow mirror is given to actually answer a heavy query. Without
# the split, one dead mirror at the front of the order cost the full read
# timeout on every single round, which is what made every fetch look like it
# was hanging rather than retrying.
OVERPASS_TIMEOUT_S = (10.0, 300.0)

# A heavy query (hundreds of thousands of elements, which a regional bbox
# routinely is) is exactly the kind of request the public Overpass mirrors
# 504 on under load - transient, and often gone a round or two later, once
# whatever spike caused it has passed. Every mirror is tried before any
# waiting happens - a mirror that is merely busy this second is worth trying
# once before writing off the whole fetch - and only once every mirror has
# failed does the round sleep and try them all again.
OVERPASS_ROUNDS = 3
OVERPASS_BACKOFF_S = (10.0, 30.0)

# A mirror that failed drifts to the back of the queue for every later fetch,
# not just the rest of this one. kumi.systems once spent a whole day
# answering 500/502 to everything, and a queue that always starts at the
# front paid its refusal on every single fetch of a multi-hour bake. A
# success resets the count, so a mirror that recovers earns its place back.
_MIRROR_FAILURES: Dict[str, int] = {}
# Fetches run a few at a time (see overpass_fetch_many), so the tally is
# shared between threads.
_MIRROR_LOCK = threading.Lock()


def mirror_order(prefer: Optional[str] = None) -> List[str]:
    """Overpass mirrors, least-failing first; ties keep `OVERPASS_URLS` order.

    `prefer` puts one mirror first regardless of its tally, so concurrent
    fetches can each keep to a mirror of their own (see overpass_fetch_many);
    it still falls through to the others when that mirror fails.
    """
    with _MIRROR_LOCK:
        order = sorted(OVERPASS_URLS, key=lambda u: _MIRROR_FAILURES.get(u, 0))
    if prefer in order:
        order.remove(prefer)
        order.insert(0, prefer)
    return order


def _mirror_failed(url: str) -> None:
    with _MIRROR_LOCK:
        _MIRROR_FAILURES[url] = _MIRROR_FAILURES.get(url, 0) + 1


def _mirror_succeeded(url: str) -> None:
    with _MIRROR_LOCK:
        _MIRROR_FAILURES[url] = 0


# How many Overpass requests are in flight at once: one per mirror. Each
# concurrent fetch keeps to a mirror of its own, so no mirror sees more than
# one request at a time from this address - two at once on the same mirror
# is what earned 429s - while the whole fetch runs as wide as there are
# mirrors. The eight queries an import makes used to run one after another.
OVERPASS_CONCURRENCY = len(OVERPASS_URLS)

# The grid an Overpass fetch is cut into: whole tiles at this zoom, on the
# same lattice as everything else the bake writes. A cache entry is one
# cell, so a widened, nudged or neighbouring bbox re-fetches only the cells
# it did not already have, instead of everything under a bbox whose text
# no longer hashes the same. z7 is 1.4 degrees a side: a 6 degree box is
# 25 cells, an island a handful, and a cell's answer stays small enough
# that the mirrors do not 504 on it.
OVERPASS_CELL_ZOOM = 7

# The grid for a query whose answer is small no matter how wide the box -
# aerodromes and runways, a few hundred elements per region. Cutting those
# at z7 multiplied the requests without saving a byte: a z5 cell is 16 z7
# cells, so the two light airfield groups cost a sixteenth of the round trips.
OVERPASS_LIGHT_CELL_ZOOM = 5

# Mirrors whose empty answer is never believed (see refuse_untrusted_empty).
# overpass.osm.ch was the one that answered HTTP 200, no remark and
# `elements: []` for boxes the others count thousands of ways in - its
# extract simply ends outside Switzerland - and it is no longer queried at
# all (see OVERPASS_URLS). Empty for now; the guard stays wired so a mirror
# caught doing the same can be listed without touching the fetch path.
OVERPASS_UNTRUSTED_EMPTY: Tuple[str, ...] = ()

# Every query ends this way: matched elements with their tags, and the
# coordinates of every way and relation member inline. The `out body; >;
# out skel qt;` form it replaced printed a separate node object for every
# vertex - 94% of all elements on a regional answer, none of them tagged -
# and re-sent every shoreline node once per group that touched it.
# `expand_geometry` turns the answer back into the node-indexed shape the
# assembly code reads.
OVERPASS_OUT = 'out geom;'


def remark_is_failure(remark: str) -> bool:
    """Whether an Overpass ``remark`` means the answer is incomplete.

    Overpass answers a query it could not finish with HTTP 200 and a
    ``remark`` field instead of a 5xx - a timeout or an out-of-memory kill
    reads as success to anything that only checks the status code. Both
    start with "runtime error:"; anything else (a note about a deprecated
    tag, say) is informational and the data beside it is still whole.
    """
    return remark.strip().lower().startswith('runtime error')


# --- tile grid --------------------------------------------------------

@dataclass(frozen=True)
class Bounds:
    west: float
    south: float
    east: float
    north: float

    def as_overpass(self) -> str:
        return f'{self.south},{self.west},{self.north},{self.east}'

    def as_box(self) -> Polygon:
        return box(self.west, self.south, self.east, self.north)


def tile_bounds(z: int, x: int, y: int) -> Bounds:
    span = 180.0 / (1 << z)
    west = -180.0 + x * span
    north = 90.0 - y * span
    return Bounds(west, north - span, west + span, north)


def tile_range_for_bounds(z: int, b: Bounds) -> Tuple[int, int, int, int]:
    span = 180.0 / (1 << z)
    nx, ny = (1 << (z + 1)), (1 << z)
    x0 = int(math.floor((b.west + 180.0) / span))
    x1 = int(math.ceil((b.east + 180.0) / span)) - 1
    y0 = int(math.floor((90.0 - b.north) / span))
    y1 = int(math.ceil((90.0 - b.south) / span)) - 1
    return (max(0, x0), max(0, y0), min(nx - 1, max(0, x1)), min(ny - 1, max(0, y1)))


def snap_bounds_to_tiles(b: Bounds, zoom: int) -> Bounds:
    """Grow a bbox outwards until it lands on whole tile edges at `zoom`.

    Every tile this bake writes is written *whole*, from land assembled for the
    bbox and nothing else. A tile the bbox cuts through therefore comes out land
    on one side of the cut and open ocean on the other — and it is written over
    whatever a previous area baked there.

    That is the seam between two imported areas. Measured on two overlapping
    Crimea imports: the second area's raw southern edge fell at lat 45.204449,
    a third of the way down tile row 1019, and the bake rewrote that whole row
    with the lower two thirds as sea. A 3.5 km strip of Black Sea straight
    across the middle of the peninsula, over ground the first area had baked
    correctly.

    Snapping is the same fix `fetch_planet_dem.py` already applies to the DEM,
    and for the same reason: a stage whose sources stop mid-tile cannot write
    that tile. Outwards rather than inwards, so nothing the caller asked for is
    dropped; the cost is at most one extra tile ring, baked with real data.
    """
    span = 180.0 / (1 << zoom)
    # A bbox already on an edge must not grow: floating point lands a whole
    # number a hair either side of itself, and ceil() of 1020.0000001 is a tile
    # further out than asked for.
    lo = lambda v: math.floor(v + 1e-9)
    hi = lambda v: math.ceil(v - 1e-9)
    return Bounds(
        west=lo((b.west + 180.0) / span) * span - 180.0,
        south=90.0 - hi((90.0 - b.south) / span) * span,
        east=hi((b.east + 180.0) / span) * span - 180.0,
        north=90.0 - lo((90.0 - b.north) / span) * span,
    )


def glue_negative_bbox(argv: Sequence[str]) -> List[str]:
    """Rewrite ``--bbox -18.66,...`` into the ``--bbox=-18.66,...`` argparse takes.

    Every western-hemisphere bbox starts with a minus, and argparse reads that
    as the next option rather than this one's value - including the Canaries
    example in this file's own docstring, which could not be run as written.
    Its negative-number escape hatch only recognises a bare number, and a bbox
    has commas in it.
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


def parse_bbox(text: str) -> Bounds:
    parts = [float(p.strip()) for p in text.split(',')]
    if len(parts) != 4:
        raise ValueError('bbox must be west,south,east,north')
    return Bounds(parts[0], parts[1], parts[2], parts[3])


def load_manifest(path: str) -> dict:
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


# --- Overpass client --------------------------------------------------

def overpass_cache_path(query: str) -> str:
    key = hashlib.sha1(query.encode('utf-8')).hexdigest()[:16]
    return os.path.join(OSM_CACHE_DIR, f'{key}.pkl.gz')


def _legacy_cache_path(query: str) -> str:
    """Where an answer fetched before the pickle cache landed would be."""
    return overpass_cache_path(query)[:-len('.pkl.gz')] + '.json.gz'


def _read_cache(query: str) -> Optional[Tuple[dict, str]]:
    """The cached answer and the file it came from, or None.

    Pickle rather than JSON, at the lightest gzip level: a hit on a
    regional answer used to cost tens of seconds of `json.load` over a
    45 MB gzip written at level 9, which is most of what a warm-cache bake
    spent in its fetch phases. A pre-pickle `.json.gz` entry is still read,
    and rewritten in the new form so the next hit is fast.
    """
    cache = overpass_cache_path(query)
    if os.path.isfile(cache):
        try:
            with gzip.open(cache, 'rb') as fh:
                return pickle.load(fh), cache
        except Exception:
            print(f'  cached answer unreadable ({cache}), re-fetching', file=sys.stderr)
            return None
    legacy = _legacy_cache_path(query)
    if os.path.isfile(legacy):
        try:
            with gzip.open(legacy, 'rt', encoding='utf-8') as fh:
                data = json.load(fh)
        except Exception:
            print(f'  cached answer unreadable ({legacy}), re-fetching', file=sys.stderr)
            return None
        _write_cache(query, data)
        return data, legacy
    return None


def _write_cache(query: str, data: dict) -> str:
    cache = overpass_cache_path(query)
    os.makedirs(OSM_CACHE_DIR, exist_ok=True)
    tmp = f'{cache}.{os.getpid()}.{threading.get_ident()}.tmp'
    with gzip.open(tmp, 'wb', compresslevel=1) as fh:
        pickle.dump(data, fh, protocol=pickle.HIGHEST_PROTOCOL)
    os.replace(tmp, cache)
    return cache


class _WaitTicker:
    """Prints `still waiting for <mirror> (45s)` every few seconds until stopped.

    An Overpass mirror spends most of a regional query's wall-clock time
    computing before it sends a single byte, and `requests.post` blocks for
    all of it. Without this the importer's log goes quiet for minutes with no
    way to tell a slow mirror from a hung one.
    """

    def __init__(self, url: str, every_s: float = 10.0):
        self._url = url
        self._every = every_s
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._started = time.monotonic()

    def _run(self) -> None:
        while not self._stop.wait(self._every):
            elapsed = time.monotonic() - self._started
            print(f'  still waiting for {self._url} ({elapsed:.0f}s)', flush=True)

    def __enter__(self) -> '_WaitTicker':
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self._stop.set()
        self._thread.join()


def _read_json_streamed(resp, on_progress: Callable[[int], None]) -> dict:
    """Pull the body down in chunks, reporting the byte count as it grows.

    Overpass answers are chunked with no Content-Length, so this cannot know
    the total - the caller turns a byte count into whatever estimate it wants
    to show. Reports at most twice a second and always once at the end.
    """
    chunks: List[bytes] = []
    received = 0
    last = 0.0
    for chunk in resp.iter_content(chunk_size=1 << 18):
        if not chunk:
            continue
        chunks.append(chunk)
        received += len(chunk)
        now = time.monotonic()
        if now - last >= 0.5:
            on_progress(received)
            last = now
    on_progress(received)
    return json.loads(b''.join(chunks))


def overpass_fetch(
    query: str, label: str, refresh: bool,
    validate: Optional[Callable[..., None]] = None,
    on_progress: Optional[Callable[[int], None]] = None,
    prefer: Optional[str] = None,
) -> dict:
    """One Overpass request, cached by query hash.

    The answer comes back with `expand_geometry` applied, so a query that
    ends in `out geom;` reads like the old node-recursing form. The cache
    holds the compact answer as the mirror sent it.

    `on_progress`, when given, is called with the number of body bytes
    received so far while the answer streams in, and a "still waiting" line
    is printed every few seconds while the mirror is computing - the two
    together are what the in-app importer shows during the minutes an
    Overpass fetch can take. Without it the request is read in one go as
    before.

    Every mirror (in :func:`mirror_order`) is tried once per round before any
    round sleeps; `OVERPASS_ROUNDS` rounds are attempted before giving up. A
    regional bbox routinely asks for hundreds of thousands of elements, which
    is exactly the kind of request the public mirrors 504 on under load - a
    5xx, a connection error, an unparseable body, or an HTTP-200 answer whose
    `remark` says the query died server-side are all treated the same way:
    the mirror's failure count goes up and the next mirror gets a turn. A 4xx
    is the query's own fault and no mirror or wait will fix it, so that fails
    the whole fetch at once.

    `validate`, when given, is a last check before the answer is trusted: it
    is called as `validate(data, mirror=url)` and raises on a response that
    parsed fine and carried no `remark` but is still wrong. overpass.osm.ch has been seen returning HTTP 200 with a
    clean, remark-free body and zero elements for a runways query over a bbox
    its own aerodromes query just answered with thousands - a truncated
    answer that looks exactly like "this bbox has none", not a fetch that
    failed. A response `validate` rejects is treated like any other mirror
    failure - counted against that mirror, retried on the next one - and,
    importantly, never cached: caching it would make the mirror's mistake
    permanent for every later run of the same bbox.
    """
    if not refresh:
        hit = _read_cache(query)
        if hit is not None:
            data, cache = hit
            print(f'using cached OSM {label} ({cache})')
            return expand_geometry(data)

    headers = {
        'User-Agent': 'retroflightsim-coast-bake/1.0',
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    }
    body = ('data=' + requests.utils.quote(query)).encode('utf-8')
    last_err: Optional[str] = None
    for round_idx in range(OVERPASS_ROUNDS):
        for url in mirror_order(prefer):
            suffix = '' if round_idx == 0 else f' (round {round_idx + 1}/{OVERPASS_ROUNDS})'
            print(f'fetching OSM {label} via Overpass ({url}){suffix}…', flush=True)
            streamed = on_progress is not None
            try:
                if streamed:
                    with _WaitTicker(url):
                        resp = requests.post(
                            url, data=body, headers=headers, timeout=OVERPASS_TIMEOUT_S,
                            stream=True)
                else:
                    resp = requests.post(url, data=body, headers=headers, timeout=OVERPASS_TIMEOUT_S)
            except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as err:
                last_err = str(err)
                print(f'  overpass failed: {last_err}', file=sys.stderr)
                _mirror_failed(url)
                continue

            if resp.status_code >= 400:
                if resp.status_code < 500 and resp.status_code != 429:
                    raise RuntimeError(
                        f'overpass rejected the query ({resp.status_code} '
                        f'{resp.reason}): {resp.text[:200]}')
                last_err = f'{resp.status_code} {resp.reason}'
                print(f'  overpass failed: {last_err}', file=sys.stderr)
                _mirror_failed(url)
                continue

            try:
                if streamed:
                    data = _read_json_streamed(resp, on_progress)
                else:
                    data = resp.json()
            except requests.exceptions.RequestException as err:
                # The connection dropped partway through the body.
                last_err = str(err)
                print(f'  overpass failed: {last_err}', file=sys.stderr)
                _mirror_failed(url)
                continue
            except ValueError:
                last_err = 'response was not JSON'
                print(f'  overpass failed: {last_err}', file=sys.stderr)
                _mirror_failed(url)
                continue

            remark = data.get('remark')
            if remark and remark_is_failure(remark):
                last_err = remark
                print(f'  overpass failed: {remark}', file=sys.stderr)
                _mirror_failed(url)
                continue
            if remark:
                print(f'  overpass remark: {remark}', file=sys.stderr)

            if validate is not None:
                try:
                    validate(data, mirror=url)
                except Exception as err:
                    last_err = str(err)
                    print(f'  overpass answer rejected: {last_err}', file=sys.stderr)
                    _mirror_failed(url)
                    continue

            _mirror_succeeded(url)
            try:
                print(f'  cached to {_write_cache(query, data)}')
            except Exception as err:
                print(f'  could not cache the response: {err}', file=sys.stderr)
            return expand_geometry(data)

        if round_idx < OVERPASS_ROUNDS - 1:
            delay = OVERPASS_BACKOFF_S[round_idx]
            print(f'  every mirror failed, retrying in {delay:.0f}s…', flush=True)
            time.sleep(delay)
    raise RuntimeError(
        f'all Overpass mirrors failed after {OVERPASS_ROUNDS} rounds: {last_err}')


def overpass_fetch_many(
    requests_: Sequence[Tuple[str, str]], refresh: bool,
    validates: Optional[Sequence[Optional[Callable[..., None]]]] = None,
    on_progress: Optional[Callable[[int, int], None]] = None,
    concurrency: int = OVERPASS_CONCURRENCY,
    on_error: Optional[Callable[[int, Exception], None]] = None,
) -> List[dict]:
    """`overpass_fetch` over several (query, label) pairs, a few at a time.

    Results come back in the order asked. `validates`, when given, is one
    `validate` per request. `on_progress(index, received)` hears each
    request's byte count as it grows. Each request keeps its own cache
    entry, so a mix of hits and misses only fetches the misses. A request
    that fails after every mirror and round raises out of here once the
    others have finished, unless `on_error(index, err)` is given, in which
    case it hears the failure and that request's answer comes back empty.
    """
    results: List[Optional[dict]] = [None] * len(requests_)
    failures: List[Tuple[int, Exception]] = []
    failures_lock = threading.Lock()

    # Each worker slot owns one mirror, best first, so requests spread over
    # the mirrors instead of piling onto the least-failing one.
    slots = mirror_order()
    free: List[int] = list(range(min(concurrency, len(slots))))
    free_lock = threading.Lock()

    def one(index: int) -> None:
        query, label = requests_[index]
        extra: Dict[str, object] = {}
        if on_progress is not None:
            extra['on_progress'] = lambda received, index=index: on_progress(index, received)
        validate = validates[index] if validates is not None else None
        with free_lock:
            slot = free.pop(0) if free else None
        try:
            results[index] = overpass_fetch(
                query, label, refresh, validate=validate,
                prefer=slots[slot] if slot is not None else None, **extra)
        except Exception as err:
            if on_error is None:
                raise
            with failures_lock:
                failures.append((index, err))
        finally:
            if slot is not None:
                with free_lock:
                    free.append(slot)

    if len(requests_) <= 1 or concurrency <= 1:
        for i in range(len(requests_)):
            one(i)
    else:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=min(concurrency, len(slots))) as pool:
            for future in [pool.submit(one, i) for i in range(len(requests_))]:
                future.result()
    if on_error is not None:
        for index, err in sorted(failures, key=lambda f: f[0]):
            on_error(index, err)
    return [r if r is not None else {'elements': []} for r in results]


def bounds_cells(b: Bounds, zoom: int = OVERPASS_CELL_ZOOM) -> List[Bounds]:
    """Whole tiles at `zoom` covering `b`, row by row - the units a fetch is cut into."""
    x0, y0, x1, y1 = tile_range_for_bounds(zoom, b)
    return [tile_bounds(zoom, x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]


def refuse_untrusted_empty() -> Callable[..., None]:
    """A `validate` that refuses an empty answer from an untrusted mirror.

    overpass.osm.ch answers a query with HTTP 200, no remark and an empty
    `elements: []` for boxes the other mirrors count thousands of ways in -
    on 2026-09-15 it did so for a North Sea coast cell overpass-api.de put
    3401 water ways in, with a database timestamp of "34". No status code
    tells that apart from a box that really has nothing in it, so an empty
    answer from a mirror in `OVERPASS_UNTRUSTED_EMPTY` is never believed:
    the query goes on to the next mirror, and if every trusted mirror fails
    every round the fetch fails rather than caching a lie. An empty answer
    from a trusted mirror is taken at its word, so the open-ocean cells of
    a coastal import cost one request each, and one from the cache
    (`mirror` is None) was a trusted mirror's to begin with.

    Accepting the untrusted mirror's empty answer on its second try, which
    this used to do, cached "no water" for that coast cell.
    """
    def validate(data: dict, mirror: Optional[str] = None) -> None:
        if not data.get('elements') and mirror in OVERPASS_UNTRUSTED_EMPTY:
            raise RuntimeError('came back with zero elements from a mirror that is not '
                               'trusted with an empty answer - asking another')
    return validate


def _synthetic_node_id(lon: float, lat: float) -> int:
    """A negative id for a vertex known only by its coordinates.

    Deterministic in the coordinates, so the same vertex reached from two
    ways, two cells or two groups gets the same id and chains across them;
    negative, so it can never collide with a real OSM node id.
    """
    return -(hash((lon, lat)) & ((1 << 62) - 1)) - 1


def expand_geometry(data: dict) -> dict:
    """An `out geom;` answer in the shape of an `out body; >; out skel qt;` one.

    Every way's inline `geometry` becomes a `nodes` list of ids, every
    relation member's inline geometry becomes a way element of its own
    (unless the same way was matched outright, in which case that tagged
    copy stands), and one node element is emitted per distinct vertex.
    Vertex ids are synthesised from the coordinates (see
    `_synthetic_node_id`) rather than taken from the way's own `nodes`
    list, because a relation member carries no node ids at all, and a
    shoreline shared by a matched way and a member way must chain.

    An answer with no inline geometry - the old form, or a test fixture -
    passes through untouched.
    """
    elements = data.get('elements', [])
    if not any('geometry' in el or any('geometry' in m for m in el.get('members', ()))
               for el in elements):
        return data
    nodes: Dict[int, dict] = {}
    out: List[dict] = []
    matched_ways: Set[int] = set()

    def ids_for(geometry: Sequence[Optional[dict]]) -> List[int]:
        ids: List[int] = []
        for pt in geometry:
            if not pt:
                continue  # Overpass prints null for a vertex it could not resolve
            lon, lat = pt['lon'], pt['lat']
            nid = _synthetic_node_id(lon, lat)
            if nid not in nodes:
                nodes[nid] = {'type': 'node', 'id': nid, 'lon': lon, 'lat': lat}
            ids.append(nid)
        return ids

    for el in elements:
        kind = el.get('type')
        if kind == 'way' and 'geometry' in el:
            way = {k: v for k, v in el.items() if k != 'geometry'}
            way['nodes'] = ids_for(el['geometry'])
            out.append(way)
            matched_ways.add(el['id'])
        elif kind == 'way':
            out.append(el)
            matched_ways.add(el['id'])
        elif kind == 'relation':
            out.append(dict(el))
        else:
            out.append(el)

    for el in out:
        if el.get('type') != 'relation':
            continue
        members: List[dict] = []
        for m in el.get('members', []):
            geometry = m.get('geometry')
            if m.get('type') == 'way' and geometry:
                if m['ref'] not in matched_ways:
                    out.append({'type': 'way', 'id': m['ref'], 'nodes': ids_for(geometry)})
                    matched_ways.add(m['ref'])
                m = {k: v for k, v in m.items() if k != 'geometry'}
            members.append(m)
        el['members'] = members

    out.extend(nodes.values())
    return {**data, 'elements': out}


def merge_elements(answers: Sequence[dict]) -> dict:
    """The union of several Overpass answers, each element once by (type, id)."""
    seen: Set[Tuple[str, int]] = set()
    elements: List[dict] = []
    for data in answers:
        for el in data.get('elements', []):
            key = (el.get('type', ''), el.get('id', 0))
            if key in seen:
                continue
            seen.add(key)
            elements.append(el)
    return {'elements': elements}


def overpass_fetch_cells(
    query_for: Callable[[Bounds], str], b: Bounds, label: str, refresh: bool,
    on_progress: Optional[Callable[[int], None]] = None,
    guard_empty: bool = True,
    zoom: int = OVERPASS_CELL_ZOOM,
    skip: Optional[Callable[[Bounds], bool]] = None,
) -> dict:
    """One logical fetch over `b`, made as one request per grid cell.

    `query_for(cell)` builds the query text for a cell. Every cell answer is
    cached on its own, so two imports that overlap share the cells they
    have in common, and one that grows a box fetches only the new ring.
    The result covers the cells' union, a superset of `b`; callers clip.
    `on_progress` hears the total bytes received so far across all cells.
    `zoom` picks the cell size: `OVERPASS_LIGHT_CELL_ZOOM` for a query whose
    answer stays small however wide the box. A cell `skip` says yes to is
    taken as empty without a request (see `sea_cell_skipper`).
    """
    answers = overpass_fetch_groups(
        [(query_for, label, skip)], b, refresh,
        on_progress=(lambda _g, n: on_progress(n)) if on_progress is not None else None,
        guard_empty=guard_empty, zoom=zoom)
    return answers[0]


def overpass_fetch_groups(
    groups: Sequence[Tuple[Callable[[Bounds], str], str, Optional[Callable[[Bounds], bool]]]],
    b: Bounds, refresh: bool,
    on_progress: Optional[Callable[[int, int], None]] = None,
    guard_empty: bool = True,
    zoom: int = OVERPASS_CELL_ZOOM,
    tolerate: Optional[Sequence[bool]] = None,
) -> List[Optional[dict]]:
    """Several logical fetches over `b` in one batch, one answer per group.

    Each group is `(query_for, label, skip)` as `overpass_fetch_cells` takes
    them. Every cell of every group goes into a single batch, so the mirror
    slots stay busy through the tail of one group with the cells of the
    next, instead of idling between groups the way back-to-back batches
    did. `on_progress(group_index, received)` hears each group's bytes.
    `tolerate[i]`, when true, lets group `i` fail: its answer comes back as
    None and the failure is printed, where any other group's failure raises
    once the batch has finished.
    """
    cells = bounds_cells(b, zoom)
    requests_: List[Tuple[str, str]] = []
    validates: List[Optional[Callable[..., None]]] = []
    owner: List[int] = []  # request index -> group index
    skipped_answers: List[Optional[dict]] = [None] * len(groups)
    for g, (query_for, label, skip) in enumerate(groups):
        wanted = [cell for cell in cells if skip is None or not skip(cell)]
        if len(wanted) < len(cells):
            print(f'  {label}: {len(cells) - len(wanted)} of {len(cells)} cells are open sea '
                  'by the DEM, not fetched', flush=True)
        for i, cell in enumerate(wanted):
            requests_.append((query_for(cell), f'{label} [{i + 1}/{len(wanted)}]'))
            validates.append(refuse_untrusted_empty() if guard_empty else None)
            owner.append(g)
        skipped_answers[g] = {'elements': []}

    received = [0] * len(requests_)
    per_group = [0] * len(groups)

    def progress(index: int, n: int) -> None:
        received[index] = n
        g = owner[index]
        per_group[g] = sum(r for r, o in zip(received, owner) if o == g)
        if on_progress is not None:
            on_progress(g, per_group[g])

    failed: Dict[int, Exception] = {}

    def on_error(index: int, err: Exception) -> None:
        failed.setdefault(owner[index], err)

    answers = overpass_fetch_many(
        requests_, refresh, validates=validates,
        on_progress=progress if on_progress is not None else None,
        on_error=on_error if tolerate is not None else None)

    out: List[Optional[dict]] = []
    for g, (_query_for, label, _skip) in enumerate(groups):
        if g in failed:
            if tolerate is not None and tolerate[g]:
                print(f'  {label} unavailable ({failed[g]})', file=sys.stderr)
                out.append(None)
                continue
            raise failed[g]
        out.append(merge_elements([a for a, o in zip(answers, owner) if o == g]))
    return out


def sea_cell_skipper(
    out_dir: str, sea_level: float = 0.0, zoom: int = OVERPASS_CELL_ZOOM,
) -> Callable[[Bounds], bool]:
    """A `skip` for `overpass_fetch_cells`: true for a cell the DEM says is all sea.

    A fetch cell is a whole tile at `zoom` on the pyramid's own lattice, so
    the question is answered by that tile: the DEM merge writes a tile only
    where its source had land, so a missing tile after the merge of this
    box is a cell with no land inside the box, and a tile that exists but
    never rises above sea level is the same thing. A tile with voids is not
    trusted either way. Only ever applied to the queries that need land to
    have anything in them - water, landuse, taxiways - never to the
    coastline, which can clip a cell's edge from a neighbour, and never to
    aerodromes, so an offshore helipad still comes through.

    The skip must not write a cache entry: the same cell can be land for a
    neighbouring import whose box covers the cell's other side.
    """
    span = 180.0 / (1 << zoom)
    level_dir = os.path.join(out_dir, str(zoom))
    if not os.path.isdir(level_dir):
        # No pyramid at this zoom at all: the DEM stage has not run, so a
        # missing tile means nothing. Ask for every cell.
        return lambda _cell: False

    def skip(cell: Bounds) -> bool:
        x = int(math.floor(((cell.west + cell.east) / 2 + 180.0) / span))
        y = int(math.floor((90.0 - (cell.south + cell.north) / 2) / span))
        path = os.path.join(out_dir, str(zoom), str(x), f'{y}.pdm')
        if not os.path.isfile(path):
            return True
        try:
            with open(path, 'rb') as fh:
                grid = decode_pdm(fh.read())
        except Exception:
            return False
        if np.isnan(grid).any():
            return False
        return bool(grid.max() <= sea_level)
    return skip


# --- OSM element helpers ----------------------------------------------

def nodes_map(elements: Sequence[dict]) -> Dict[int, Tuple[float, float]]:
    out: Dict[int, Tuple[float, float]] = {}
    for el in elements:
        if el.get('type') == 'node':
            out[el['id']] = (el['lon'], el['lat'])
    return out

def _chain_rings(segments: Sequence[Sequence[int]], nodes: Dict[int, Tuple[float, float]]) -> List[List[Tuple[float, float]]]:
    """Chain way node lists end to end into closed rings of coordinates."""
    rings: List[List[Tuple[float, float]]] = []
    used: Set[int] = set()
    for start_idx, start_nodes in enumerate(segments):
        if start_idx in used:
            continue
        chain = list(start_nodes)
        used.add(start_idx)
        changed = True
        while changed:
            changed = False
            for j, seg in enumerate(segments):
                if j in used or not seg:
                    continue
                if chain[-1] == seg[0]:
                    chain.extend(seg[1:])
                    used.add(j)
                    changed = True
                elif chain[-1] == seg[-1]:
                    chain.extend(reversed(seg[:-1]))
                    used.add(j)
                    changed = True
                elif chain[0] == seg[-1]:
                    chain = list(seg[:-1]) + chain
                    used.add(j)
                    changed = True
                elif chain[0] == seg[0]:
                    chain = list(reversed(seg[1:])) + chain
                    used.add(j)
                    changed = True
        if len(chain) >= 4 and chain[0] == chain[-1]:
            rings.append([nodes[n] for n in chain if n in nodes])
    return rings


def _member_ways(relation: dict, ways: Dict[int, dict], roles: Tuple[str, ...]) -> List[List[int]]:
    out: List[List[int]] = []
    for m in relation.get('members', []):
        if m.get('type') != 'way' or m.get('role') not in roles:
            continue
        wid = m.get('ref')
        if wid in ways:
            out.append(ways[wid].get('nodes', []))
    return out


def relation_rings(relation: dict, ways: Dict[int, dict], nodes: Dict[int, Tuple[float, float]]) -> List[List[Tuple[float, float]]]:
    """Assemble the *outer* rings of a multipolygon relation, holes ignored.

    Enough for a centroid or a footprint area (the airport bake). Anything
    that turns the relation into a surface wants `relation_polygons`, or the
    inner rings - every island in a lake or a river mapped as a relation -
    come out as part of the water.
    """
    outer_ways = _member_ways(relation, ways, ('outer', ''))
    if not outer_ways:
        return []
    return _chain_rings(outer_ways, nodes)


def relation_polygons(relation: dict, ways: Dict[int, dict], nodes: Dict[int, Tuple[float, float]]) -> List[Polygon]:
    """Assemble a multipolygon relation into polygons with their holes.

    Every `inner` ring is punched out of the smallest outer ring that
    contains it. Until 2026-09-16 the coast bake only ever chained the outer
    members, so a lake or riverbank relation flooded its islands whole:
    Berlin's Spreeinsel, every Rhine island, anything mapped as
    `natural=water` + `inner`. A ring that fails to close is dropped, as it
    always was; an inner ring that sits in no outer is dropped too.
    """
    outers = _chain_rings(_member_ways(relation, ways, ('outer', '')), nodes)
    inners = _chain_rings(_member_ways(relation, ways, ('inner',)), nodes)
    shells: List[Tuple[Polygon, List[List[Tuple[float, float]]]]] = []
    for ring in outers:
        if len(ring) < 4:
            continue
        try:
            shell = Polygon(ring)
        except Exception:
            continue
        if shell.is_empty or shell.area <= 0:
            continue
        shells.append((shell, []))
    shells.sort(key=lambda s: s[0].area)
    for ring in inners:
        if len(ring) < 4:
            continue
        try:
            hole = Polygon(ring)
        except Exception:
            continue
        if hole.is_empty:
            continue
        probe = hole.representative_point()
        for shell, holes in shells:
            if shell.contains(probe):
                holes.append(ring)
                break
    out: List[Polygon] = []
    for shell, holes in shells:
        try:
            poly = Polygon(shell.exterior.coords, holes) if holes else shell
        except Exception:
            poly = shell
        if not poly.is_valid:
            fixed = poly.buffer(0)
            if isinstance(fixed, Polygon):
                poly = fixed
            elif not fixed.is_empty:
                out.extend(g for g in getattr(fixed, 'geoms', []) if isinstance(g, Polygon) and not g.is_empty)
                continue
        if not poly.is_empty:
            out.append(poly)
    return out


def ways_map(elements: Sequence[dict]) -> Dict[int, dict]:
    """Ways by id, keeping the tagged copy when an id appears more than once.

    Overpass answers `out body; >; out skel qt;` by printing the matched
    elements with their tags and then everything reached by recursion *without*
    them. A coastline way that is also a member of, say, a water relation comes
    back twice - once tagged, once as a bare skeleton - and a plain
    `{el['id']: el}` lets whichever arrives last win.

    On the Crimea bbox that silently untagged 163 of 667 coastline ways. The
    remaining 504 could not close the chain, `polygonize` returned a single
    face the size of the bbox, and the entire peninsula baked as open sea.
    """
    out: Dict[int, dict] = {}
    for el in elements:
        if el.get('type') != 'way':
            continue
        prev = out.get(el['id'])
        if prev is None or (not prev.get('tags') and el.get('tags')):
            out[el['id']] = el
    return out

def tagged_width_m(tags: dict) -> Optional[float]:
    """Metres from a `width` tag, tolerating the usual '12 m' / '12,5' forms."""
    raw = tags.get('width') or tags.get('est_width')
    if not raw:
        return None
    text = str(raw).strip().replace(',', '.')
    number = ''
    for ch in text:
        if ch.isdigit() or ch == '.':
            number += ch
        else:
            break
    try:
        value = float(number)
    except ValueError:
        return None
    return value if value > 0 else None


# --- baked pyramid readers --------------------------------------------

PDM_MAGIC = b'PDM1'
PDM_HEADER_BYTES = 24
PDM_NODATA = 0xFFFF

# Decoded .pdm tiles held at once. 257x257 float32 is 264 KB, so this is a
# ~70 MB ceiling on a bake that would otherwise cache the whole pyramid.
DEM_CACHE_TILES = 256

def decode_pdm(blob: bytes) -> np.ndarray:
    """Heights from a .pdm tile as float32, voids as NaN.

    A local reader rather than an import of tools/bake_planet_dem.py: that
    module requires rasterio at import time and this one deliberately treats
    rasterio as optional. The on-disk format is fixed, so the duplication is
    cheap where the dependency would not be.
    """
    payload = zlib.decompress(blob)
    magic, n, _flags, _pad, lo, _hi, scale, _err = struct.unpack_from(
        '<4sHBBffff', payload, 0)
    if magic != PDM_MAGIC:
        raise ValueError(f'not a {PDM_MAGIC.decode()} tile: {magic!r}')
    q = np.frombuffer(payload, dtype='<u2', count=n * n,
                      offset=PDM_HEADER_BYTES).reshape(n, n)
    grid = (lo + q.astype(np.float32) * scale).astype(np.float32)
    grid[q == PDM_NODATA] = np.nan
    return grid

class DemSampler:
    """Nearest-node lookups into the .pdm pyramid at one zoom level."""

    def __init__(self, out_dir: str, zoom: int, tile_size: int):
        self.out_dir = out_dir
        self.zoom = zoom
        self.n = tile_size
        self.span = 180.0 / (1 << zoom)
        self._cache: Dict[Tuple[int, int], Optional[np.ndarray]] = {}

    def _tile(self, x: int, y: int) -> Optional[np.ndarray]:
        key = (x, y)
        if key not in self._cache:
            if len(self._cache) >= DEM_CACHE_TILES:
                self._cache.clear()
            path = os.path.join(self.out_dir, str(self.zoom), str(x), f'{y}.pdm')
            grid: Optional[np.ndarray] = None
            if os.path.isfile(path):
                try:
                    with open(path, 'rb') as fh:
                        grid = decode_pdm(fh.read())
                except Exception:
                    grid = None
            self._cache[key] = grid
        return self._cache[key]

    def sample(self, lon: float, lat: float) -> float:
        """Height at lon/lat, or NaN where the pyramid holds no data."""
        x = int(math.floor((lon + 180.0) / self.span))
        y = int(math.floor((90.0 - lat) / self.span))
        grid = self._tile(x, y)
        if grid is None:
            return float('nan')
        b = tile_bounds(self.zoom, x, y)
        cells = self.n - 1
        col = int(round((lon - b.west) / (b.east - b.west) * cells))
        row = int(round((b.north - lat) / (b.north - b.south) * cells))
        return float(grid[min(cells, max(0, row)), min(cells, max(0, col))])

def decode_lwm(blob: bytes) -> Tuple[bytearray, int]:
    """Inverse of :func:`encode_lwm`: returns (grid, n)."""
    payload = zlib.decompress(blob)
    magic, n, _f0, _f1 = struct.unpack('<4sHBB', payload[:8])
    if magic != LWM_MAGIC:
        raise ValueError(f'not a {LWM_MAGIC.decode()} tile: {magic!r}')
    return bytearray(payload[8:8 + n * n]), n

def read_lwm(out_dir: str, z: int, x: int, y: int) -> Optional[bytearray]:
    """A previously baked mask, or None if this tile was never written.

    Needed because a coarse mask is decimated from its four children, and
    :func:`build_parent_mask` leaves any quadrant it is not given as water. Bake
    one area and the ancestors it shares with an area baked earlier would come
    back with that earlier land drowned.
    """
    path = os.path.join(out_dir, str(z), str(x), f'{y}.lwm')
    if not os.path.isfile(path):
        return None
    with open(path, 'rb') as fh:
        grid, _n = decode_lwm(fh.read())
    return grid

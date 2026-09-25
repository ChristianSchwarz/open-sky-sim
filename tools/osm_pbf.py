"""Read OSM elements out of a local .osm.pbf extract, in the same shape
`overpass_fetch*` returns after `expand_geometry` (see tools/osm_common.py):
nodes with `lon`/`lat`, ways with `tags` + ordered `nodes: [id, ...]`,
relations with `tags` + `members: [{type, ref, role}]`.

This exists because every OSM fetch in this pipeline (coast, airports,
roads) currently depends on live public Overpass mirrors, which are
reliable for a single cell but not for a whole 100x100km area: on a real
import the taxiways/aprons/landuse/roads fetches spent minutes retrying
429/504s across all three mirrors for answers a few hundred KB in size (see
docs/terrain-import-speed.md, 2026-09-24 update). A local extract removes
that dependency entirely for anyone who has one.

Requires ``osmium`` (the PyPI package, despite the ``import osmium`` name
and the ``pyosmium`` project name)::

    pip install osmium

Get a regional extract from https://download.geofabrik.de/ - a
country or sub-region file, not the full planet, is enough for a
100x100km-at-a-time workflow and keeps the file a manageable size. The
same file is reused for every future import inside its coverage.
"""

import gzip
import hashlib
import os
import pickle
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from osm_common import Bounds

try:
    import osmium
except ImportError:  # pragma: no cover - reported to the caller, not raised here.
    osmium = None

TagPredicate = Callable[[dict], bool]

# One group's answer per file, keyed on the source file's own content (mtime
# + size, so a re-clipped or re-downloaded extract never serves a stale
# answer) rather than its path - the same shape osm_common's Overpass cache
# uses, for the same reason: a coast bake and a cover bake are two separate
# Python processes reading the same clipped extract for the same landuse
# tags, and without this each pays its own multi-minute scan of it. See
# docs/terrain-import-speed.md's "next optimization" note.
PBF_CACHE_DIR = os.path.join('data', 'osm-cache', 'pbf')


def pbf_available() -> bool:
    return osmium is not None


def _tags_dict(obj) -> dict:
    return {t.k: t.v for t in obj.tags}


_MEMBER_TYPE = {'n': 'node', 'w': 'way', 'r': 'relation'}


def _cache_path(pbf_path: str, bbox: Bounds, key: str, include_relations: bool) -> str:
    st = os.stat(pbf_path)
    fingerprint = '|'.join([
        os.path.abspath(pbf_path), str(st.st_mtime_ns), str(st.st_size),
        f'{bbox.west:.6f},{bbox.south:.6f},{bbox.east:.6f},{bbox.north:.6f}',
        key, 'rel' if include_relations else 'norel',
    ])
    digest = hashlib.sha1(fingerprint.encode('utf-8')).hexdigest()[:16]
    return os.path.join(PBF_CACHE_DIR, f'{digest}.pkl.gz')


def _cache_get(path: str) -> Optional[dict]:
    if not os.path.isfile(path):
        return None
    try:
        with gzip.open(path, 'rb') as fh:
            return pickle.load(fh)
    except Exception:
        return None


def _cache_put(path: str, data: dict) -> None:
    os.makedirs(PBF_CACHE_DIR, exist_ok=True)
    tmp = path + '.tmp'
    with gzip.open(tmp, 'wb', compresslevel=1) as fh:
        pickle.dump(data, fh, protocol=pickle.HIGHEST_PROTOCOL)
    os.replace(tmp, path)


def pbf_elements(
    pbf_path: str, bbox: Bounds, predicate: TagPredicate, key: str,
    include_relations: bool = True, refresh: bool = False,
) -> dict:
    """Elements from a local .osm.pbf matching `predicate(tags)`, clipped to `bbox`.

    `key` names this predicate for the on-disk cache (see
    `pbf_elements_groups`'s docstring) - it is not derived from `predicate`
    itself, since a Python function can't be hashed stably, so it must be
    passed explicitly and two callers wanting to share a cache hit (coast's
    landuse read and `bake_planet_cover.py`'s) must agree on the same string.
    A key that is only ever used by one caller still needs one, if only to
    keep that caller's own cache entries from colliding with another
    caller's at the same bbox - `'_'` for every single-group caller was
    exactly that bug, before this parameter existed: roads' and coast's
    reads of the same bbox overwrote each other's cache entry.

    Returns `{'elements': [...]}`, the same shape `overpass_fetch_cells`
    returns. See `pbf_elements_groups` when more than one predicate is
    needed over the same file - each `pbf_elements` call is a full read of
    the file, so several calls cost several reads (unless every one of them
    is already cached; see `pbf_elements_groups`'s docstring).
    """
    return pbf_elements_groups(pbf_path, bbox, [(key, predicate)], include_relations, refresh)[key]


def pbf_elements_groups(
    pbf_path: str, bbox: Bounds,
    groups: Sequence[Tuple[str, TagPredicate]],
    include_relations: bool = True,
    refresh: bool = False,
) -> Dict[str, dict]:
    """As `pbf_elements`, for several `(key, predicate)` groups in one pass.

    The cost of reading a country-sized extract is the scan (hundreds of
    seconds for a Portugal-sized file), not evaluating one more predicate
    per element - so four groups tested together in one call cost about what
    one does, instead of four separate `pbf_elements` calls each re-reading
    the whole file. Measured on `bake_osm_airports.py`'s four aeroway
    groups, run as four separate calls before this existed: 929s total for a
    Lisbon-sized bbox, almost all of it four redundant scans of the same
    424 MB Portugal extract.

    Each group's answer is also cached on disk, keyed on the source file's
    mtime+size, the bbox and the group's own key (see `_cache_path`) - not
    on the predicate itself, which is a Python function and can't be hashed
    stably, so two callers must agree on the same `key` for the same tag
    test to share a hit (`bake_osm_coast.py` and `bake_planet_cover.py` both
    use `'landuse'`). This is what lets a coast bake's landuse read and a
    later, separate `bake_planet_cover.py --osm-landuse` process (two
    different Python interpreters, so nothing in memory carries over) share
    one scan instead of paying for it twice. `refresh=True` (wired to the
    same `--refresh-osm` flag the Overpass cache already uses) bypasses a
    cache hit and overwrites it - for after the source file itself changed
    without its mtime moving, e.g. a fresh `clip_pbf.py` run given the same
    output path some tooling might not update the timestamp on.

    Returns `{key: {'elements': [...]}, ...}`, one answer per group, each in
    the same shape `overpass_fetch_cells` returns.
    """
    cache_paths = {key: _cache_path(pbf_path, bbox, key, include_relations) for key, _ in groups}
    answers: Dict[str, dict] = {}
    if not refresh:
        for key, _ in groups:
            hit = _cache_get(cache_paths[key])
            if hit is not None:
                answers[key] = hit
    to_scan = [(key, predicate) for key, predicate in groups if key not in answers]
    if not to_scan:
        return answers

    scanned = _scan_groups(pbf_path, bbox, to_scan, include_relations)
    for key, data in scanned.items():
        _cache_put(cache_paths[key], data)
    answers.update(scanned)
    return answers


def _scan_groups(
    pbf_path: str, bbox: Bounds,
    groups: Sequence[Tuple[str, TagPredicate]],
    include_relations: bool,
) -> Dict[str, dict]:
    """The uncached read `pbf_elements_groups` falls back to for its cache misses."""
    if osmium is None:
        raise RuntimeError(
            "reading a .osm.pbf needs the 'osmium' package: pip install osmium")

    keys = [key for key, _ in groups]
    matched_ways: Dict[str, Dict[int, dict]] = {key: {} for key in keys}
    matched_relations: Dict[str, Dict[int, dict]] = {key: {} for key in keys}
    matched_nodes: Dict[str, Dict[int, dict]] = {key: {} for key in keys}
    wanted_way_ids: Dict[str, set] = {key: set() for key in keys}

    # Pass 1: classify every node/way/relation against every group's
    # predicate in one read, and remember which node ids (and, for a
    # relation, which member way ids) each group needs. A standalone node is
    # a first-class match too - Overpass's `node[...]` half of a `nwr[...]`
    # query catches features (most small airfields) that are only ever
    # mapped as a single point, never a way or relation.
    class ScanHandler(osmium.SimpleHandler):
        def node(self, n):
            loc = n.location
            if not loc.valid():
                return
            tags: Optional[dict] = None
            for key, predicate in groups:
                if tags is None:
                    tags = _tags_dict(n)
                if not predicate(tags):
                    continue
                matched_nodes[key][n.id] = {'type': 'node', 'id': n.id, 'tags': tags, 'lon': loc.lon, 'lat': loc.lat}

        def way(self, w):
            tags: Optional[dict] = None
            node_ids: Optional[List[int]] = None
            for key, predicate in groups:
                if tags is None:
                    tags = _tags_dict(w)
                if not predicate(tags):
                    continue
                if node_ids is None:
                    node_ids = [n.ref for n in w.nodes]
                    if not node_ids:
                        break
                matched_ways[key][w.id] = {'type': 'way', 'id': w.id, 'tags': tags, 'nodes': node_ids}

        def relation(self, r):
            if not include_relations:
                return
            tags: Optional[dict] = None
            members: Optional[List[dict]] = None
            for key, predicate in groups:
                if tags is None:
                    tags = _tags_dict(r)
                if not predicate(tags):
                    continue
                if members is None:
                    members = [{'type': _MEMBER_TYPE.get(m.type, m.type), 'ref': m.ref, 'role': m.role}
                               for m in r.members]
                matched_relations[key][r.id] = {'type': 'relation', 'id': r.id, 'tags': tags, 'members': members}
                for m in r.members:
                    if m.type == 'w':
                        wanted_way_ids[key].add(m.ref)

    ScanHandler().apply_file(pbf_path)

    # A relation member way is included in its own group even when it
    # carries no tags of its own (or tags that don't match that group's
    # predicate) - the same way Overpass's `out geom;` on a matched relation
    # includes its members' geometry unconditionally.
    all_extra_ids: set = set()
    for key in keys:
        all_extra_ids |= wanted_way_ids[key] - matched_ways[key].keys()
    if all_extra_ids:
        found: Dict[int, dict] = {}

        class MemberWayHandler(osmium.SimpleHandler):
            def way(self, w):
                if w.id not in all_extra_ids:
                    return
                node_ids = [n.ref for n in w.nodes]
                if node_ids:
                    found[w.id] = {'type': 'way', 'id': w.id, 'tags': _tags_dict(w), 'nodes': node_ids}

        MemberWayHandler().apply_file(pbf_path)
        for key in keys:
            for wid in wanted_way_ids[key] - matched_ways[key].keys():
                if wid in found:
                    matched_ways[key][wid] = found[wid]

    wanted_node_ids = {nid for key in keys for way in matched_ways[key].values() for nid in way['nodes']}

    # Pass 2: resolve coordinates for exactly the nodes any group's matched
    # ways need, in one more read. A way that leaves the box (a road or
    # coastline crossing the edge) keeps its out-of-box nodes too, the same
    # way an Overpass cell answer includes a way's full geometry even where
    # it runs past the cell edge - callers clip afterwards, same as the
    # Overpass path.
    nodes: Dict[int, dict] = {}

    class NodeHandler(osmium.SimpleHandler):
        def node(self, n):
            if n.id not in wanted_node_ids:
                return
            loc = n.location
            if not loc.valid():
                return
            nodes[n.id] = {'type': 'node', 'id': n.id, 'lon': loc.lon, 'lat': loc.lat}

    NodeHandler().apply_file(pbf_path)

    def in_bbox(nid: int) -> bool:
        n = nodes.get(nid)
        return n is not None and bbox.west <= n['lon'] <= bbox.east and bbox.south <= n['lat'] <= bbox.north

    def way_touches_bbox(way: dict) -> bool:
        return any(in_bbox(nid) for nid in way['nodes'])

    answers: Dict[str, dict] = {}
    for key in keys:
        elements = [w for w in matched_ways[key].values() if way_touches_bbox(w)]
        kept_way_ids = {w['id'] for w in elements}
        kept_node_ids = {nid for w in elements for nid in w['nodes'] if nid in nodes}
        elements.extend(nodes[nid] for nid in kept_node_ids)
        if include_relations:
            elements.extend(
                r for r in matched_relations[key].values()
                if any(m['type'] == 'way' and m['ref'] in kept_way_ids for m in r['members']))
        elements.extend(
            n for n in matched_nodes[key].values()
            if bbox.west <= n['lon'] <= bbox.east and bbox.south <= n['lat'] <= bbox.north)
        answers[key] = {'elements': elements}
    return answers

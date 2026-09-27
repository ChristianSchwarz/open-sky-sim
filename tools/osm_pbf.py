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


def pbf_prefetch(
    pbf_path: str, bbox: Bounds,
    specs: Sequence[Tuple[str, TagPredicate, bool]],
    refresh: bool = False,
) -> Dict[str, int]:
    """Fill the cache for every (key, predicate, include_relations) in one read.

    The bake stages of one import chunk - coast, roads, airfields, cover -
    each read the same extract for the same bbox with their own tags: three
    full reads a chunk before this. The importer runs this once per chunk
    first, and every stage's own `pbf_elements*` call is then a cache hit
    under exactly the key it would have written. Returns element counts of
    what it had to read.
    """
    todo = [(k, p, rel) for k, p, rel in specs
            if refresh or _cache_get(_cache_path(pbf_path, bbox, k, rel)) is None]
    counts: Dict[str, int] = {}
    if not todo:
        return counts
    answers = _scan_groups(pbf_path, bbox, [(k, p) for k, p, _ in todo], True,
                           relation_keys={k for k, _, rel in todo if rel})
    for k, _, rel in todo:
        _cache_put(_cache_path(pbf_path, bbox, k, rel), answers[k])
        counts[k] = len(answers[k]['elements'])
    return counts


def _scan_groups_serial(
    pbf_path: str, bbox: Bounds,
    groups: Sequence[Tuple[str, TagPredicate]],
    include_relations: bool,
) -> Dict[str, dict]:
    """`_scan_groups` on one core, for predicates that cannot be pickled to workers.

    Only a way with a node inside `bbox` can end up in an answer (and so
    only a relation with such a member way), so that is all Python ever
    sees: numpy finds the node ids inside the box on every core
    (`clip_pbf.node_ids_in`), and osmium's C++ `IdTracker` filters drop
    every other node, way and relation before a callback would run. Before
    this, every object of the file went through a Python callback that
    built its tag dict - one core, ~20 min per stage on a 391 MB extract,
    repeated by every stage of every chunk.
    """
    if osmium is None:
        raise RuntimeError(
            "reading a .osm.pbf needs the 'osmium' package: pip install osmium")
    from clip_pbf import node_ids_in, node_tracker

    keys = [key for key, _ in groups]
    matched_ways: Dict[str, Dict[int, dict]] = {key: {} for key in keys}
    matched_relations: Dict[str, Dict[int, dict]] = {key: {} for key in keys}
    matched_nodes: Dict[str, Dict[int, dict]] = {key: {} for key in keys}
    wanted_way_ids: Dict[str, set] = {key: set() for key in keys}

    in_box = node_tracker(node_ids_in(pbf_path, (bbox.west, bbox.south, bbox.east, bbox.north)))

    # Standalone nodes: a first-class match too - Overpass's `node[...]`
    # half of a `nwr[...]` query catches features (most small airfields)
    # that are only ever mapped as a single point. Untagged nodes are
    # skipped in C++ unless some predicate would accept no tags at all.
    nodes_fp = osmium.FileProcessor(pbf_path, osmium.osm.NODE).with_filter(in_box.id_filter())
    if not any(predicate({}) for _, predicate in groups):
        nodes_fp = nodes_fp.with_filter(osmium.filter.EmptyTagFilter())
    for n in nodes_fp:
        tags = _tags_dict(n)
        loc = n.location
        for key, predicate in groups:
            if predicate(tags):
                matched_nodes[key][n.id] = {'type': 'node', 'id': n.id, 'tags': tags,
                                            'lon': loc.lon, 'lat': loc.lat}

    # Every way touching the box, matched or not: a relation's member way is
    # included in its group whatever its own tags - the same way Overpass's
    # `out geom;` on a matched relation includes its members' geometry.
    touching: Dict[int, dict] = {}
    touching_ids = osmium.IdTracker()
    for w in osmium.FileProcessor(pbf_path, osmium.osm.WAY).with_filter(in_box.contains_filter()):
        node_ids = [n.ref for n in w.nodes]
        if not node_ids:
            continue
        way = {'type': 'way', 'id': w.id, 'tags': _tags_dict(w), 'nodes': node_ids}
        touching[w.id] = way
        touching_ids.add_way(w.id)
        for key, predicate in groups:
            if predicate(way['tags']):
                matched_ways[key][w.id] = way

    if include_relations:
        for r in osmium.FileProcessor(pbf_path, osmium.osm.RELATION).with_filter(
                touching_ids.contains_filter()):
            tags = _tags_dict(r)
            members: Optional[List[dict]] = None
            for key, predicate in groups:
                if not predicate(tags):
                    continue
                if members is None:
                    members = [{'type': _MEMBER_TYPE.get(m.type, m.type), 'ref': m.ref, 'role': m.role}
                               for m in r.members]
                matched_relations[key][r.id] = {'type': 'relation', 'id': r.id, 'tags': tags,
                                                'members': members}
                for m in members:
                    if m['type'] == 'way' and m['ref'] in touching:
                        wanted_way_ids[key].add(m['ref'])
        for key in keys:
            for wid in wanted_way_ids[key] - matched_ways[key].keys():
                matched_ways[key][wid] = touching[wid]

    # Coordinates for every node of every answer way, including the ones
    # outside the box: a road or coastline crossing the edge keeps its full
    # geometry, as an Overpass cell answer does - callers clip afterwards.
    wanted = osmium.IdTracker()
    for key in keys:
        for way in matched_ways[key].values():
            for nid in way['nodes']:
                wanted.add_node(nid)
    nodes: Dict[int, dict] = {}
    for n in osmium.FileProcessor(pbf_path, osmium.osm.NODE).with_filter(wanted.id_filter()):
        loc = n.location
        if loc.valid():
            nodes[n.id] = {'type': 'node', 'id': n.id, 'lon': loc.lon, 'lat': loc.lat}

    answers: Dict[str, dict] = {}
    for key in keys:
        elements = list(matched_ways[key].values())
        kept_way_ids = {w['id'] for w in elements}
        kept_node_ids = {nid for w in elements for nid in w['nodes'] if nid in nodes}
        elements.extend(nodes[nid] for nid in kept_node_ids)
        if include_relations:
            elements.extend(
                r for r in matched_relations[key].values()
                if any(m['type'] == 'way' and m['ref'] in kept_way_ids for m in r['members']))
        elements.extend(matched_nodes[key].values())
        answers[key] = {'elements': elements}
    return answers


# --- the parallel scan -------------------------------------------------------

_SCAN: dict = {}


def _scan_init(pbf_path: str, head: Tuple[int, int], groups, bounds, touching_path: str,
               skip_untagged: bool) -> None:
    import numpy as np
    # Memory-mapped, so every worker shares one copy through the page cache.
    # An osmium IdTracker of the box's nodes per worker was a bitset over the
    # whole node id range - over a GB each, and 16 of them ran out of memory.
    touching = np.memmap(touching_path, dtype=np.int64, mode='r') if os.path.getsize(touching_path) else         np.zeros(0, np.int64)
    _SCAN.update(path=pbf_path, head=head, groups=groups, bounds=bounds, touching=touching,
                 skip_untagged=skip_untagged)


def _scan_batch(task):
    """One run of blobs: its matched tagged nodes and touching ways.

    Returns (batch index, {key: [node dict]}, {key: [way dict]}). A way
    that touches the box but matches no group costs one id lookup - most of
    them are buildings and roads nobody asked for, and building their tags
    and node lists was half of the serial scan.
    """
    import numpy as np
    index, first, end = task
    with open(_SCAN['path'], 'rb') as fh:
        fh.seek(_SCAN['head'][0])
        data = fh.read(_SCAN['head'][1])
        fh.seek(first)
        data += fh.read(end - first)
    groups = _SCAN['groups']
    west, south, east, north = _SCAN['bounds']
    nodes: Dict[str, list] = {key: [] for key, _ in groups}
    ways: Dict[str, list] = {key: [] for key, _ in groups}
    touching = _SCAN['touching']
    last = len(touching) - 1

    fp = osmium.FileProcessor(osmium.io.FileBuffer(data, 'pbf'), osmium.osm.NODE)
    if _SCAN['skip_untagged']:
        fp = fp.with_filter(osmium.filter.EmptyTagFilter())
    for n in fp:
        loc = n.location
        if not loc.valid():
            continue
        lon, lat = loc.lon, loc.lat
        if not (west <= lon <= east and south <= lat <= north):
            continue
        tags = _tags_dict(n)
        for key, predicate in groups:
            if predicate(tags):
                nodes[key].append({'type': 'node', 'id': n.id, 'tags': tags, 'lon': lon, 'lat': lat})

    for w in osmium.FileProcessor(osmium.io.FileBuffer(data, 'pbf'), osmium.osm.WAY):
        wid = w.id
        i = int(np.searchsorted(touching, wid))
        if i > last or touching[i] != wid:
            continue
        tags = _tags_dict(w)
        keys = [key for key, predicate in groups if predicate(tags)]
        if keys:
            way = {'type': 'way', 'id': w.id, 'tags': tags, 'nodes': [r.ref for r in w.nodes]}
            for key in keys:
                ways[key].append(way)
    return index, nodes, ways


def _scan_groups(
    pbf_path: str, bbox: Bounds,
    groups: Sequence[Tuple[str, TagPredicate]],
    include_relations: bool,
    workers: Optional[int] = None,
    relation_keys: Optional[set] = None,
) -> Dict[str, dict]:
    """The uncached read `pbf_elements_groups` falls back to for its cache misses.

    `relation_keys` picks, per group, whether relations (and their member
    ways) are part of its answer; by default all groups or none, as
    `include_relations` says. `pbf_prefetch` needs the mix: the roads read
    is relation-free, the coast and airfield reads are not.

    Only a way with a node inside `bbox` can end up in an answer (and so
    only a relation with such a member way). The file is read on every core:
    numpy finds the node ids inside the box (`clip_pbf.node_ids_in`), each
    worker takes a run of blobs and tests its tagged nodes and - through an
    osmium C++ `IdTracker` filter, so a way that misses the box never reaches
    Python - its touching ways against the groups; numpy then decodes the
    coordinates of every answer way's nodes (`clip_pbf.node_coords`). Only
    relations, a few thousand, are read on one core.

    The serial version, one Python callback per touching way and per answer
    node, took 401 s on its own and 889 s inside the Erz import for one
    chunk's coast and landuse read of a 698 MB extract. Answers are the same
    element sets; predicates that cannot be pickled (a closure) take the
    serial path.
    """
    if osmium is None:
        raise RuntimeError(
            "reading a .osm.pbf needs the 'osmium' package: pip install osmium")
    rel_keys = set(relation_keys) if relation_keys is not None else (
        {key for key, _ in groups} if include_relations else set())
    try:
        pickle.dumps(list(groups))
    except Exception:
        with_rel = [(k, p) for k, p in groups if k in rel_keys]
        without = [(k, p) for k, p in groups if k not in rel_keys]
        answers = _scan_groups_serial(pbf_path, bbox, with_rel, True) if with_rel else {}
        if without:
            answers.update(_scan_groups_serial(pbf_path, bbox, without, False))
        return answers
    import multiprocessing as mp
    import tempfile
    import numpy as np
    from clip_pbf import blob_index, default_workers, node_batches, node_coords, node_ids_in, node_tracker

    workers = workers or default_workers()
    keys = [key for key, _ in groups]
    bounds = (bbox.west, bbox.south, bbox.east, bbox.north)
    # The ways touching the box, by id: one C++-filtered pass with one
    # tracker, Python seeing only an id per touching way.
    tracker = node_tracker(node_ids_in(pbf_path, bounds, workers))
    touching_ids = np.fromiter(
        (w.id for w in osmium.FileProcessor(pbf_path, osmium.osm.WAY).with_filter(tracker.contains_filter())),
        dtype=np.int64)
    del tracker
    touching_ids.sort()
    blobs = blob_index(pbf_path)
    head = (blobs[0][1], blobs[0][2])
    tasks = [(i, a, b) for i, (a, b) in enumerate(node_batches(pbf_path, workers))]

    fd, touching_path = tempfile.mkstemp(suffix='.ids')
    os.close(fd)
    results = []
    try:
        touching_ids.tofile(touching_path)
        skip_untagged = not any(predicate({}) for _, predicate in groups)
        ctx = mp.get_context('spawn')
        with ctx.Pool(min(workers, max(1, len(tasks))), _scan_init,
                      (pbf_path, head, list(groups), bounds, touching_path, skip_untagged)) as pool:
            results = list(pool.imap_unordered(_scan_batch, tasks))
    finally:
        try:
            os.remove(touching_path)
        except OSError:
            pass  # still mapped by a worker on its way out; it is only a temp file
    results.sort(key=lambda r: r[0])

    # In file order, as the serial scan inserted them.
    matched_nodes: Dict[str, Dict[int, dict]] = {key: {} for key in keys}
    matched_ways: Dict[str, Dict[int, dict]] = {key: {} for key in keys}
    for _, nodes, ways in results:
        for key in keys:
            for n in nodes[key]:
                matched_nodes[key][n['id']] = n
            for w in ways[key]:
                matched_ways[key][w['id']] = w
    touching = set(touching_ids.tolist())

    matched_relations: Dict[str, Dict[int, dict]] = {key: {} for key in keys}
    if rel_keys and touching:
        touching_tracker = osmium.IdTracker()
        for wid in touching:
            touching_tracker.add_way(wid)
        wanted_way_ids: Dict[str, set] = {key: set() for key in keys}
        for r in osmium.FileProcessor(pbf_path, osmium.osm.RELATION).with_filter(
                touching_tracker.contains_filter()):
            tags = _tags_dict(r)
            members: Optional[List[dict]] = None
            for key, predicate in groups:
                if key not in rel_keys or not predicate(tags):
                    continue
                if members is None:
                    members = [{'type': _MEMBER_TYPE.get(m.type, m.type), 'ref': m.ref, 'role': m.role}
                               for m in r.members]
                matched_relations[key][r.id] = {'type': 'relation', 'id': r.id, 'tags': tags,
                                                'members': members}
                for m in members:
                    if m['type'] == 'way' and m['ref'] in touching:
                        wanted_way_ids[key].add(m['ref'])
        # A relation's member way belongs to its group whatever its own tags,
        # the same as Overpass's `out geom;` on a matched relation.
        missing = {wid for key in keys for wid in wanted_way_ids[key] - matched_ways[key].keys()}
        if missing:
            member_tracker = osmium.IdTracker()
            for wid in missing:
                member_tracker.add_way(wid)
            members_found: Dict[int, dict] = {}
            for w in osmium.FileProcessor(pbf_path, osmium.osm.WAY).with_filter(member_tracker.id_filter()):
                node_ids = [r.ref for r in w.nodes]
                if node_ids:
                    members_found[w.id] = {'type': 'way', 'id': w.id, 'tags': _tags_dict(w), 'nodes': node_ids}
            for key in keys:
                for wid in wanted_way_ids[key] - matched_ways[key].keys():
                    if wid in members_found:
                        matched_ways[key][wid] = members_found[wid]

    # Coordinates for every node of every answer way, including the ones
    # outside the box: a road or coastline crossing the edge keeps its full
    # geometry, as an Overpass cell answer does - callers clip afterwards.
    wanted_ids = np.fromiter(
        (nid for key in keys for way in matched_ways[key].values() for nid in way['nodes']),
        dtype=np.int64)
    got_ids, lons, lats = node_coords(pbf_path, wanted_ids, workers)
    nodes: Dict[int, dict] = {
        nid: {'type': 'node', 'id': nid, 'lon': lon, 'lat': lat}
        for nid, lon, lat in zip(got_ids.tolist(), lons.tolist(), lats.tolist())}

    answers: Dict[str, dict] = {}
    for key in keys:
        elements = list(matched_ways[key].values())
        kept_way_ids = {w['id'] for w in elements}
        kept_node_ids = {nid for w in elements for nid in w['nodes'] if nid in nodes}
        elements.extend(nodes[nid] for nid in kept_node_ids)
        if key in rel_keys:
            elements.extend(
                r for r in matched_relations[key].values()
                if any(m['type'] == 'way' and m['ref'] in kept_way_ids for m in r['members']))
        elements.extend(matched_nodes[key].values())
        answers[key] = {'elements': elements}
    return answers

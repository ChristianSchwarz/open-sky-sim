#!/usr/bin/env python3
"""Clip a regional .osm.pbf down to a bbox, for a fast repeatable local read.

`tools/osm_pbf.py`'s scan cost is proportional to the whole input file, not
the bbox - reading all of a country-sized extract for one 100x100km import
costs minutes per stage even though only a slice of it matters (see
docs/terrain-import-speed.md's 2026-09-24 update). Clipping once with this
script and pointing `--pbf` at the small output instead cuts every later
read down to the bbox's own size.

A node is kept if it falls in the bbox (padded - see MARGIN_DEG); a way is
kept if any of its own node ids were kept; a relation is kept if any member
way was kept. A way that crosses the padded
edge keeps every node id it had, but only the in-padding ones resolve to
coordinates in the output file - `pbf_elements_groups`'s own NodeHandler
already tolerates a way with some unresolved node ids (see its docstring),
the same way an Overpass cell answer's edge-crossing ways are clipped by
the caller, not by the fetch.

No Python code runs per object the clip drops. A Python osmium callback per
object managed ~3 MB/s, so a country took hours (Germany, 4.8 GB: ~2 h
single-process, still ~40 min spread over every core). Instead:

1. Which nodes are in the box is decided by decoding the PBF's DenseNodes
   coordinate arrays with numpy, blob by blob, on every core - the one test
   osmium has no C++ filter for. Node blobs are ordered by id, not place, so
   nearly every blob holds some node of any box; there is nothing to skip,
   only per-node work to vectorise.
2. Three osmium passes with C++ filters then write the output in order:
   nodes by those ids, ways referencing a kept node, relations referencing a
   kept way. A pass over all of Germany's ways takes ~10 s this way.

Usage::

    python tools/clip_pbf.py --bbox -9.6,38.5,-8.4,39.4 \\
        --in data/imports/portugal-latest.osm.pbf --out data/imports/lisbon.osm.pbf

Requires ``osmium`` (pip install osmium) and numpy.
"""

import argparse
import multiprocessing as mp
import os
import struct
import sys
import tempfile
import time
import zlib
from typing import List, Optional, Tuple

import numpy as np

try:
    import osmium
except ImportError:
    print('error: osmium is required (pip install osmium)', file=sys.stderr)
    raise

from osm_common import glue_negative_bbox

# Degrees of padding added around the bbox before clipping, so a way or
# relation that crosses the requested edge (a road, a coastline, a long
# lake) still has enough of its nodes to resolve a real geometry instead of
# fraying at the box edge. Matches the spirit of the Overpass path fetching
# whole z7/z8 cells around the bbox for the same reason.
MARGIN_DEG = 0.05


def parse_bbox(text: str):
    parts = [float(p.strip()) for p in text.split(',')]
    if len(parts) != 4:
        raise ValueError('bbox must be west,south,east,north')
    return parts


# --- raw PBF reading ----------------------------------------------------------

def _read_varint(buf, i: int):
    value = shift = 0
    while True:
        b = buf[i]
        i += 1
        value |= (b & 0x7f) << shift
        shift += 7
        if b < 0x80:
            return value, i


def _fields(buf, i: int, end: int):
    """Top-level protobuf fields of `buf[i:end]`: `(field, int)` or `(field, (start, end))`."""
    while i < end:
        key, i = _read_varint(buf, i)
        field, wire = key >> 3, key & 7
        if wire == 0:
            v, i = _read_varint(buf, i)
            yield field, v
        elif wire == 2:
            n, i = _read_varint(buf, i)
            yield field, (i, i + n)
            i += n
        elif wire == 1:
            i += 8
        elif wire == 5:
            i += 4
        else:
            raise ValueError(f'unsupported protobuf wire type {wire}')


def blob_index(path: str) -> List[Tuple[str, int, int]]:
    """Every blob in a PBF as `(type, offset, length)`, headers only - no decompression.

    A PBF is a run of `[u32 size][BlobHeader][Blob]` frames, each blob
    compressed on its own, so the workers can each take a run of them.
    8 s for Germany's 64k blobs.
    """
    out = []
    with open(path, 'rb') as fh:
        while True:
            off = fh.tell()
            raw = fh.read(4)
            if len(raw) < 4:
                return out
            hlen = struct.unpack('>I', raw)[0]
            header = fh.read(hlen)
            kind, size = '', 0
            for field, v in _fields(header, 0, hlen):
                if field == 1:
                    kind = header[v[0]:v[1]].decode('ascii')
                elif field == 3:
                    size = v
            fh.seek(size, 1)
            out.append((kind, off, 4 + hlen + size))


def _varints(a: np.ndarray) -> np.ndarray:
    """Every varint in a packed field, decoded at once."""
    ends = np.flatnonzero(a < 0x80)
    if len(ends) == 0:
        return np.zeros(0, np.uint64)
    starts = np.empty_like(ends)
    starts[0] = 0
    starts[1:] = ends[:-1] + 1
    lens = ends - starts + 1
    vals = (a[starts] & 0x7f).astype(np.uint64)
    for k in range(1, int(lens.max())):
        m = lens > k
        vals[m] |= (a[starts[m] + k] & 0x7f).astype(np.uint64) << np.uint64(7 * k)
    return vals


def _unzigzag(v):
    if isinstance(v, int):
        return (v >> 1) ^ -(v & 1)
    return (v >> np.uint64(1)).astype(np.int64) ^ -((v & np.uint64(1)).astype(np.int64))


def _to_osmium(nano, granularity: int, offset: int):
    """PBF coordinate -> osmium's int32 1e-7 degrees, rounded as libosmium does.

    libosmium computes `(raw * granularity + offset) / 100` in C++ integer
    arithmetic, which truncates toward zero; its `Location.lon` is that
    divided by 1e7 as a double. Matching this exactly is what makes the
    kept set identical to a Python callback reading `n.location`.
    """
    v = nano * granularity + offset
    return np.where(v >= 0, v // 100, -((-v) // 100))


def _decode_nodes(frame: bytes) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Every valid node in one blob frame as (ids, x, y), in osmium's 1e-7 degree ints.

    `x / 1e7` is exactly what an osmium callback reads as `n.location.lon`,
    so a test on these gives the kept set a callback test would.
    """
    empty = (np.zeros(0, np.int64),) * 3
    hlen = struct.unpack('>I', frame[:4])[0]
    data = None
    for field, v in _fields(frame, 4 + hlen, len(frame)):
        if field == 1:
            data = frame[v[0]:v[1]]
        elif field == 3:
            data = zlib.decompress(frame[v[0]:v[1]])
        elif field in (4, 6, 7):
            raise ValueError('PBF blob uses lzma/lz4/zstd, which this clip does not read')
    if data is None:
        return empty
    granularity, lat_off, lon_off = 100, 0, 0
    groups = []
    for field, v in _fields(data, 0, len(data)):
        if field == 2:
            groups.append(v)
        elif field == 17:
            granularity = v
        elif field == 19:
            lat_off = _unzigzag(v)
        elif field == 20:
            lon_off = _unzigzag(v)
    a = np.frombuffer(data, np.uint8)
    parts = []
    for g0, g1 in groups:
        ids = lats = lons = None
        for field, v in _fields(data, g0, g1):
            if field == 2:  # DenseNodes
                for f2, (s, e) in _fields(data, v[0], v[1]):
                    if f2 == 1:
                        ids = np.cumsum(_unzigzag(_varints(a[s:e])))
                    elif f2 == 8:
                        lats = np.cumsum(_unzigzag(_varints(a[s:e])))
                    elif f2 == 9:
                        lons = np.cumsum(_unzigzag(_varints(a[s:e])))
            elif field == 1:  # a plain Node - rare, but legal
                nid = lat = lon = 0
                for f2, v2 in _fields(data, v[0], v[1]):
                    if f2 == 1:
                        nid = _unzigzag(v2)
                    elif f2 == 8:
                        lat = _unzigzag(v2)
                    elif f2 == 9:
                        lon = _unzigzag(v2)
                parts.append((np.array([nid]), np.array([lat]), np.array([lon])))
        if ids is not None and len(ids):
            parts.append((ids, lats, lons))
    out_ids, out_x, out_y = [], [], []
    for ids, lats, lons in parts:
        x = _to_osmium(lons.astype(np.int64), granularity, lon_off)
        y = _to_osmium(lats.astype(np.int64), granularity, lat_off)
        # Location.valid() as osmium defines it.
        m = (x >= -1800000000) & (x <= 1800000000) & (y >= -900000000) & (y <= 900000000)
        out_ids.append(ids[m])
        out_x.append(x[m])
        out_y.append(y[m])
    if not out_ids:
        return empty
    return np.concatenate(out_ids), np.concatenate(out_x), np.concatenate(out_y)


def _frames(buf: bytes):
    i = 0
    while i < len(buf):
        hlen = struct.unpack('>I', buf[i:i + 4])[0]
        size = 0
        for field, v in _fields(buf, i + 4, i + 4 + hlen):
            if field == 3:
                size = v
        frame_end = i + 4 + hlen + size
        yield buf[i:frame_end]
        i = frame_end


_WANTED: dict = {}


def _batch_nodes(task):
    """One run of blobs -> the selected nodes' ids (and, for an id list, x and y) as bytes.

    `select` is ('box', bounds) or ('ids', path of a sorted int64 id file).
    """
    path, first, end, select = task
    with open(path, 'rb') as fh:
        fh.seek(first)
        buf = fh.read(end - first)
    kind, arg = select
    if kind == 'ids' and _WANTED.get('path') != arg:
        _WANTED.update(path=arg, ids=np.fromfile(arg, dtype=np.int64))
    ids_out, x_out, y_out = [], [], []
    for frame in _frames(buf):
        ids, x, y = _decode_nodes(frame)
        if kind == 'box':
            west, south, east, north = arg
            lon = x / 1e7
            lat = y / 1e7
            m = (lon >= west) & (lon <= east) & (lat >= south) & (lat <= north)
            ids_out.append(ids[m])
        else:
            wanted = _WANTED['ids']
            pos = np.searchsorted(wanted, ids)
            m = (pos < len(wanted)) & (wanted[np.minimum(pos, len(wanted) - 1)] == ids)
            ids_out.append(ids[m])
            x_out.append(x[m])
            y_out.append(y[m])
    cat = lambda xs: np.concatenate(xs) if xs else np.zeros(0, np.int64)  # noqa: E731
    if kind == 'box':
        return cat(ids_out).tobytes()
    return cat(ids_out).tobytes(), cat(x_out).tobytes(), cat(y_out).tobytes()


def _batches(blobs, target_bytes: int):
    """Blobs cut into contiguous `(first_offset, end_offset)` runs of about `target_bytes`."""
    out = []
    i = 0
    while i < len(blobs):
        size = 0
        j = i
        while j < len(blobs) and (size == 0 or size + blobs[j][2] <= target_bytes):
            size += blobs[j][2]
            j += 1
        out.append((blobs[i][1], blobs[j - 1][1] + blobs[j - 1][2]))
        i = j
    return out


def default_workers() -> int:
    return max(1, min(16, (os.cpu_count() or 2) - 2))


def node_batches(path: str, workers: int) -> List[Tuple[int, int]]:
    """The file's data blobs as contiguous (first, end) byte runs, several per worker."""
    data = [b for b in blob_index(path) if b[0] == 'OSMData']
    total = sum(b[2] for b in data)
    # Several runs per worker so one slow run doesn't hold up the rest.
    target = max(4 << 20, min(64 << 20, total // (workers * 8) or 1))
    return _batches(data, target)


def _run_node_batches(path: str, select, workers: Optional[int], on_batch=None) -> list:
    workers = workers or default_workers()
    tasks = [(path, a, b, select) for a, b in node_batches(path, workers)]
    out = []
    if tasks:
        ctx = mp.get_context('spawn')
        with ctx.Pool(min(workers, len(tasks))) as pool:
            for got in pool.imap_unordered(_batch_nodes, tasks):
                out.append(got)
                if on_batch:
                    on_batch(len(tasks))
    return out


def node_ids_in(path: str, bounds, workers: Optional[int] = None, on_batch=None) -> np.ndarray:
    """Ids of every node of `path` inside `bounds` (inclusive), decoded on every core.

    Matches testing `west <= n.location.lon <= east` (and lat) on a
    `Location.valid()` node in an osmium callback, without one. `on_batch`
    is called with the batch count as each batch finishes, for progress.
    """
    got = _run_node_batches(path, ('box', tuple(bounds)), workers, on_batch)
    return np.concatenate([np.frombuffer(g, np.int64) for g in got]) if got else np.zeros(0, np.int64)


def node_coords(path: str, ids: np.ndarray, workers: Optional[int] = None,
                ) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(ids, lon, lat) for those of `ids` present in `path`, decoded on every core.

    lon/lat are exactly an osmium callback's `n.location.lon`/`.lat`.
    """
    wanted = np.unique(np.asarray(ids, dtype=np.int64))
    if len(wanted) == 0:
        return (np.zeros(0, np.int64), np.zeros(0), np.zeros(0))
    fd, ids_path = tempfile.mkstemp(suffix='.ids')
    os.close(fd)
    try:
        wanted.tofile(ids_path)
        got = _run_node_batches(path, ('ids', ids_path), workers)
    finally:
        os.remove(ids_path)
    out_ids = np.concatenate([np.frombuffer(g[0], np.int64) for g in got])
    x = np.concatenate([np.frombuffer(g[1], np.int64) for g in got])
    y = np.concatenate([np.frombuffer(g[2], np.int64) for g in got])
    return out_ids, x / 1e7, y / 1e7


def node_tracker(ids) -> 'osmium.IdTracker':
    """An osmium IdTracker holding node `ids`, for its C++ id/contains filters."""
    tracker = osmium.IdTracker()
    add = tracker.add_node
    for i in (ids.tolist() if isinstance(ids, np.ndarray) else ids):
        add(i)
    return tracker


def clip_pbf(in_path: str, out_path: str, bbox, margin: float = MARGIN_DEG, quiet: bool = False,
             workers: Optional[int] = None) -> dict:
    """Clip `in_path` to `bbox` (padded by `margin` degrees), writing `out_path`.

    Returns the kept element counts. Shared by this script's CLI and by
    `osm_extract.py`, which calls this whenever a box has no clipped extract
    of its own yet, so a bake stage never reads a full regional file.
    """
    west, south, east, north = bbox
    bounds = (west - margin, south - margin, east + margin, north + margin)
    say = (lambda *a, **k: None) if quiet else print
    say(f'clipping {in_path} to [{bounds[0]:.4f},{bounds[1]:.4f},{bounds[2]:.4f},{bounds[3]:.4f}] '
        f'(bbox padded {margin} deg) -> {out_path}')
    started = time.time()

    progress = [0]

    def tick(total):
        progress[0] += 1
        say(f'clip {progress[0]}/{total + 3}', flush=True)

    nodes = node_tracker(node_ids_in(in_path, bounds, workers, tick))
    steps = progress[0] + 3
    done = progress[0]
    ways = osmium.IdTracker()
    counts = {'nodes': 0, 'ways': 0, 'relations': 0}

    # Written aside and renamed, so a killed clip never leaves a truncated
    # file osm_extract.py would take for a finished one.
    tmp = out_path + '.part'
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    writer = osmium.SimpleWriter(osmium.io.File(tmp, 'pbf'), overwrite=True)
    try:
        for n in osmium.FileProcessor(in_path, osmium.osm.NODE).with_filter(nodes.id_filter()):
            writer.add_node(n)
            counts['nodes'] += 1
        done += 1
        say(f'clip {done}/{steps}', flush=True)
        for w in osmium.FileProcessor(in_path, osmium.osm.WAY).with_filter(nodes.contains_filter()):
            writer.add_way(w)
            ways.add_way(w.id)
            counts['ways'] += 1
        done += 1
        say(f'clip {done}/{steps}', flush=True)
        # `ways` holds only ways, so this is "any member way was kept" -
        # node and relation members never match.
        for r in osmium.FileProcessor(in_path, osmium.osm.RELATION).with_filter(ways.contains_filter()):
            writer.add_relation(r)
            counts['relations'] += 1
        done += 1
        say(f'clip {done}/{steps}', flush=True)
    finally:
        writer.close()
    os.replace(tmp, out_path)
    say(f'wrote {counts["nodes"]} nodes, {counts["ways"]} ways, {counts["relations"]} relations '
        f'in {time.time() - started:.1f}s')
    return counts


def merge_pbfs(paths: List[str], out_path: str) -> None:
    """Merge clipped PBFs into one sorted file, each object once.

    For a box across a border: two countries' extracts both carry the ways
    and relations that cross it (and their nodes). osmium's merge reader
    streams the largest file and folds the others in, sorted, keeping one
    copy per id - identical to clipping the union in one go (checked on two
    overlapping Canary Islands clips).
    """
    paths = sorted(paths, key=os.path.getsize, reverse=True)
    merger = osmium.MergeInputReader()
    for path in paths[1:]:
        merger.add_file(path)
    tmp = out_path + '.part'
    writer = osmium.io.Writer(osmium.io.File(tmp, 'pbf'), overwrite=True)
    try:
        merger.apply_to_reader(osmium.io.Reader(paths[0]), writer)
    finally:
        writer.close()
    os.replace(tmp, out_path)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--bbox', required=True, help='west,south,east,north degrees')
    ap.add_argument('--in', dest='in_path', required=True, help='source .osm.pbf (e.g. a Geofabrik extract)')
    ap.add_argument('--out', dest='out_path', required=True, help='clipped .osm.pbf to write')
    ap.add_argument('--margin', type=float, default=MARGIN_DEG,
                     help=f'padding in degrees around the bbox (default {MARGIN_DEG})')
    ap.add_argument('--workers', type=int, help='processes to clip with (default: cores - 2, at most 16)')
    args = ap.parse_args(glue_negative_bbox(sys.argv[1:]))

    clip_pbf(args.in_path, args.out_path, parse_bbox(args.bbox), args.margin, workers=args.workers)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

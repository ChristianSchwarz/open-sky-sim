#!/usr/bin/env python3
"""Clip a regional .osm.pbf down to a bbox, for a fast repeatable local read.

`tools/osm_pbf.py`'s scan cost is proportional to the whole input file, not
the bbox - reading all of a country-sized extract for one 100x100km import
costs minutes per stage even though only a slice of it matters (see
docs/terrain-import-speed.md's 2026-09-24 update). Clipping once with this
script and pointing `--pbf` at the small output instead cuts every later
read down to the bbox's own size.

Single pass, since a PBF from Geofabrik (or planet.osm) is ordered nodes,
then ways, then relations: by the time a way's callback runs, every node
callback that could mark its node ids "kept" has already run, and likewise
for relations after ways. A node is kept if it falls in the bbox (padded -
see MARGIN_DEG); a way is kept if any of its own node ids were kept; a
relation is kept if any member way was kept. A way that crosses the padded
edge keeps every node id it had, but only the in-padding ones resolve to
coordinates in the output file - `pbf_elements_groups`'s own NodeHandler
already tolerates a way with some unresolved node ids (see its docstring),
the same way an Overpass cell answer's edge-crossing ways are clipped by
the caller, not by the fetch.

Usage::

    python tools/clip_pbf.py --bbox -9.6,38.5,-8.4,39.4 \\
        --in data/imports/portugal-latest.osm.pbf --out data/imports/lisbon.osm.pbf

Requires ``osmium`` (pip install osmium), same as tools/osm_pbf.py.
"""

import argparse
import sys
import time

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


def clip_pbf(in_path: str, out_path: str, bbox, margin: float = MARGIN_DEG, quiet: bool = False) -> dict:
    """Clip `in_path` to `bbox` (padded by `margin` degrees), writing `out_path`.

    Returns the kept element counts. Shared by this script's CLI and by
    `osm_extract.py`, which calls this straight after a fresh download so a
    caller never reads the full, unclipped regional file.
    """
    west, south, east, north = bbox
    west -= margin
    south -= margin
    east += margin
    north += margin

    kept_nodes = set()
    kept_ways = set()
    counts = {'nodes': 0, 'ways': 0, 'relations': 0}

    writer = osmium.SimpleWriter(out_path, overwrite=True)

    class ClipHandler(osmium.SimpleHandler):
        def node(self, n):
            loc = n.location
            if loc.valid() and west <= loc.lon <= east and south <= loc.lat <= north:
                kept_nodes.add(n.id)
                writer.add_node(n)
                counts['nodes'] += 1

        def way(self, w):
            if any(nr.ref in kept_nodes for nr in w.nodes):
                kept_ways.add(w.id)
                writer.add_way(w)
                counts['ways'] += 1

        def relation(self, r):
            if any(m.type == 'w' and m.ref in kept_ways for m in r.members):
                writer.add_relation(r)
                counts['relations'] += 1

    if not quiet:
        print(f'clipping {in_path} to [{west:.4f},{south:.4f},{east:.4f},{north:.4f}] '
              f'(bbox padded {margin} deg) -> {out_path}')
    started = time.time()
    try:
        ClipHandler().apply_file(in_path)
    finally:
        writer.close()
    if not quiet:
        print(f'wrote {counts["nodes"]} nodes, {counts["ways"]} ways, {counts["relations"]} relations '
              f'in {time.time() - started:.1f}s')
    return counts


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--bbox', required=True, help='west,south,east,north degrees')
    ap.add_argument('--in', dest='in_path', required=True, help='source .osm.pbf (e.g. a Geofabrik extract)')
    ap.add_argument('--out', dest='out_path', required=True, help='clipped .osm.pbf to write')
    ap.add_argument('--margin', type=float, default=MARGIN_DEG,
                     help=f'padding in degrees around the bbox (default {MARGIN_DEG})')
    args = ap.parse_args(glue_negative_bbox(sys.argv[1:]))

    clip_pbf(args.in_path, args.out_path, parse_bbox(args.bbox), args.margin)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

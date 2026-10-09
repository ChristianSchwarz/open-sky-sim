#!/usr/bin/env python3
"""Read every OSM layer a bbox's bakes need out of a local extract, once.

The coast, road, airfield and cover bakes each read the same `.osm.pbf` for
the same bbox with their own tags. Run this first and each of their reads is
a cache hit (`osm_pbf.pbf_prefetch`): one pass over the extract per import
chunk instead of three.

Usage::

    python tools/osm_prefetch.py --pbf data/imports/pbf/area.osm.pbf --bbox 12.3,50.5,12.7,50.8
"""

from __future__ import annotations

import argparse
import sys
import time
from typing import Sequence

from bake_osm_airports import PBF_GROUPS as AIRFIELD_GROUPS
from bake_osm_buildings import building_tag_predicate
from bake_osm_coast import coast_tag_predicate
from bake_osm_roads import rail_service_tag_predicate, rail_tag_predicate, road_tag_predicate
from osm_common import glue_negative_bbox, parse_bbox
from osm_landuse import landuse_tag_predicate
from osm_pbf import pbf_prefetch

# (cache key, tag test, relations included) - each exactly as its bake asks.
SPECS = (
    ('coast', coast_tag_predicate, True),
    ('landuse', landuse_tag_predicate, True),
    ('roads', road_tag_predicate, False),
    ('rails', rail_tag_predicate, False),
    ('rail_service', rail_service_tag_predicate, False),
    ('buildings', building_tag_predicate, True),
) + tuple((key, predicate, True) for key, predicate in AIRFIELD_GROUPS)


def main(argv: Sequence[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--pbf', required=True, help='local .osm.pbf extract')
    ap.add_argument('--bbox', required=True, help='west,south,east,north degrees, as the bakes get it')
    ap.add_argument('--refresh-osm', action='store_true', help='read again even when cached')
    args = ap.parse_args(glue_negative_bbox(list(argv)))
    started = time.time()
    counts = pbf_prefetch(args.pbf, parse_bbox(args.bbox), SPECS, refresh=args.refresh_osm)
    if counts:
        print('read ' + ', '.join(f'{k} {n}' for k, n in counts.items())
              + f' elements in {time.time() - started:.1f}s')
    else:
        print('every layer already cached')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))

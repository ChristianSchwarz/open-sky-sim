#!/usr/bin/env python3
"""Remove a baked area from the terrain pyramids - the inverse of an import.

``merge_planet_dem.py`` writes an area's tiles and repairs every ancestor they
changed; this tool takes them out again and repairs the same ancestors from
whatever survives. Tiles are a global quadtree, so the area's data does not
stop at its own zoom level: every ancestor up to z0 has the area's heights
decimated into one of its quadrants, and simply deleting the fine tiles would
leave ghost mountains in the coarse view. The repair mirrors the merge:
rebuild each touched parent from the children still on disk, and delete it
outright when none survive.

A tile two areas overlap belongs to both, so only tiles no *remaining* area
claims are deleted. The draw-ready tree (``assets/terrain``) loses the same
tiles - the .ptm meshes and the copied height tiles - but its surviving coarse
meshes still show the deleted ground until ``bake_planet_mesh.ts`` is re-run
over the area's box, which is what the dev server's delete job does next.

What stays behind, deliberately: ``heightMin``/``heightMax`` and the per-level
geometric errors in the manifest (both are conservative bounds), and the colour
histogram feeding the swatch table (colours cannot be un-accumulated).

Usage::

    python tools/delete_area.py --name alps
    python tools/delete_area.py --name alps --dry-run

then re-run the mesh bake over the box it prints.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from typing import Dict, List, Optional, Sequence, Set, Tuple

from bake_planet_dem import (
    Bounds,
    build_parent,
    encode_tile,
    pack_index,
    parent_geometric_error,
    read_tile,
    tile_bounds,
    tile_range_for_bounds,
    unpack_index,
    write_tile,
)

QUADRANTS = ((0, 0), (1, 0), (0, 1), (1, 1))

# Everything a planet tile can carry: heights, coast/water vectors, cover.
PLANET_EXTS = ('.pdm', '.lvr', '.plc')
# The draw-ready tree: the mesh, the height tile copied there for physics, and
# the far-tile cover texture beside the mesh.
TERRAIN_EXTS = ('.ptm', '.pdm', '.ptx')

TileSet = Set[Tuple[int, int]]


def area_box(a: dict) -> Bounds:
    return Bounds(float(a['west']), float(a['south']), float(a['east']), float(a['north']))


def box_contains(b: Bounds, lat: float, lon: float) -> bool:
    return b.west <= lon <= b.east and b.south <= lat <= b.north


def union_box(boxes: Sequence[Bounds]) -> dict:
    return {
        'west': min(b.west for b in boxes),
        'south': min(b.south for b in boxes),
        'east': max(b.east for b in boxes),
        'north': max(b.north for b in boxes),
    }


def exclusive_tiles(
    z: int, box: Bounds, remaining: Sequence[Bounds], present: TileSet,
) -> TileSet:
    """Tiles of `present` inside `box` that no remaining area also claims.

    ``Bounds.intersects`` is open on the edges, which matters here twice over:
    boxes are snapped to tile edges, so a tile merely *touching* a neighbouring
    area's border is not claimed by it, and a tile on the deleted box's own
    border row is.
    """
    x0, y0, x1, y1 = tile_range_for_bounds(z, box)
    out: TileSet = set()
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if (x, y) not in present:
                continue
            tb = tile_bounds(z, x, y)
            if not tb.intersects(box):
                continue
            if any(tb.intersects(r) for r in remaining):
                continue
            out.add((x, y))
    return out


def pack_full_index(tiles: Dict[int, TileSet], min_zoom: int, max_zoom: int) -> bytes:
    """Pack every level in the range, empty ones included.

    ``index_levels`` skips empty levels, but the PIX1 header promises one
    level record per zoom in [min, max] - a hole in the middle would shift
    every level after it. A delete can empty a level, so this packs a zero
    box for it instead.
    """
    levels = []
    for z in range(min_zoom, max_zoom + 1):
        coords = sorted(tiles.get(z) or ())
        if coords:
            xs = [x for x, _ in coords]
            ys = [y for _, y in coords]
            levels.append((z, min(xs), min(ys),
                           max(xs) - min(xs) + 1, max(ys) - min(ys) + 1, coords))
        else:
            levels.append((z, 0, 0, 0, 0, []))
    return pack_index(levels)


def remove_tile_files(root: str, z: int, x: int, y: int, exts: Sequence[str]) -> int:
    removed = 0
    for ext in exts:
        path = os.path.join(root, str(z), str(x), f'{y}{ext}')
        if os.path.exists(path):
            os.remove(path)
            removed += 1
    return removed


def keeps_point(item: dict, box: Bounds, remaining: Sequence[Bounds]) -> bool:
    """Whether a lat/lon record survives the delete (inclusive containment)."""
    lat, lon = item.get('lat'), item.get('lon')
    if lat is None or lon is None:
        return True
    if not box_contains(box, float(lat), float(lon)):
        return True
    return any(box_contains(r, float(lat), float(lon)) for r in remaining)


def load_json(path: str) -> dict:
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def save_json(path: str, doc: dict, indent: Optional[int] = 2) -> None:
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, indent=indent)
        fh.write('\n')


def delete(args: argparse.Namespace) -> int:
    started = time.time()
    manifest_path = os.path.join(args.planet, 'manifest.json')
    if not os.path.exists(manifest_path):
        print(f'error: no pyramid at {args.planet}', file=sys.stderr)
        return 2
    manifest = load_json(manifest_path)

    areas: List[dict] = manifest.get('areas') or []
    if not areas:
        print('error: the manifest records no areas - a pyramid from before '
              'areas were recorded is all one area, and deleting it would '
              'delete everything', file=sys.stderr)
        return 2
    target = next((a for a in areas if a.get('name') == args.name), None)
    if target is None:
        names = ', '.join(a.get('name', '?') for a in areas)
        print(f'error: no area called "{args.name}" (have: {names})', file=sys.stderr)
        return 2
    if len(areas) == 1:
        print('error: refusing to delete the only area - that is the whole '
              'pyramid. Bake a replacement first, or delete the asset '
              'directories by hand.', file=sys.stderr)
        return 2

    remaining = [a for a in areas if a.get('name') != args.name]
    remaining_boxes = [area_box(a) for a in remaining]
    box = area_box(target)
    print(f'area        {args.name}: lon [{box.west:.5f}, {box.east:.5f}] '
          f'lat [{box.south:.5f}, {box.north:.5f}]')
    print(f'keeping     {", ".join(a["name"] for a in remaining)}')

    min_zoom = int(manifest['minZoom'])
    max_zoom = int(manifest['maxZoom'])
    tile_size = int(manifest['tileSize'])
    sea_level = float(manifest.get('seaLevel', 0.0))

    index_path = os.path.join(args.planet, manifest.get('indexPath', 'index.bin'))
    with open(index_path, 'rb') as fh:
        index = unpack_index(fh.read())
    total_before = sum(len(v) for v in index.values())

    delete_now = exclusive_tiles(
        max_zoom, box, remaining_boxes, index.get(max_zoom, set()))
    overlap = len([1 for xy in index.get(max_zoom, set())
                   if xy not in delete_now
                   and tile_bounds(max_zoom, *xy).intersects(box)])
    print(f'level {max_zoom:2d}    {len(delete_now)} tiles exclusive to it'
          + (f', {overlap} shared with a remaining area stay' if overlap else ''))

    if args.dry_run:
        print('\ndry run: nothing deleted')
        return 0

    # --- delete, then repair every ancestor, exactly as the merge does ------
    deleted: Dict[int, TileSet] = {}
    repaired: Dict[int, TileSet] = {}
    removed_files = 0
    repair_now: TileSet = set()
    for z in range(max_zoom, min_zoom - 1, -1):
        level = index.setdefault(z, set())
        for (x, y) in sorted(delete_now):
            removed_files += remove_tile_files(args.planet, z, x, y, PLANET_EXTS)
            level.discard((x, y))
        if delete_now:
            deleted[z] = set(delete_now)

        # Rebuild from the children still on disk - the level below is already
        # final by the time this level is reached, so what read_tile returns is
        # what the parent should decimate.
        for (px, py) in sorted(repair_now):
            children = {}
            errors = {}
            for qx, qy in QUADRANTS:
                got = read_tile(args.planet, z + 1, px * 2 + qx, py * 2 + qy)
                if got is None:
                    continue
                children[(qx, qy)], errors[(qx, qy)] = got
            parent = build_parent(children, tile_size, sea_level)
            err = parent_geometric_error(parent, children, errors, tile_size)
            write_tile(args.planet, z, px, py, encode_tile(parent, err))
        if repair_now:
            repaired[z] = set(repair_now)

        if delete_now or repair_now:
            print(f'level {z:2d}    removed {len(delete_now)}, '
                  f'rebuilt {len(repair_now)}')
        if z == min_zoom:
            break

        touched = {(x >> 1, y >> 1) for (x, y) in (delete_now | repair_now)}
        parent_level = index.get(z - 1, set())
        next_delete: TileSet = set()
        next_repair: TileSet = set()
        for (px, py) in touched:
            if (px, py) not in parent_level:
                continue
            if any((px * 2 + qx, py * 2 + qy) in level for qx, qy in QUADRANTS):
                next_repair.add((px, py))
            else:
                next_delete.add((px, py))
        delete_now, repair_now = next_delete, next_repair

    with open(index_path, 'wb') as fh:
        fh.write(pack_full_index(index, min_zoom, max_zoom))

    manifest['areas'] = remaining
    manifest['coverage'] = union_box(remaining_boxes)
    airfields = manifest.get('airfields')
    dropped_fields = 0
    if airfields and isinstance(airfields.get('items'), list):
        kept = [i for i in airfields['items']
                if keeps_point(i, box, remaining_boxes)]
        dropped_fields = len(airfields['items']) - len(kept)
        airfields['items'] = kept
        if 'count' in airfields:
            airfields['count'] = len(kept)
    save_json(manifest_path, manifest)

    # --- the draw-ready tree ------------------------------------------------
    # The same tiles go, both trees' indexes are pruned, and the height copies
    # of repaired ancestors are refreshed. Surviving coarse *meshes* still show
    # the deleted ground - only the mesh bake can rebuild those, which is why
    # this ends by saying to run it.
    tman_path = os.path.join(args.terrain, 'manifest.json')
    if os.path.exists(tman_path):
        tman = load_json(tman_path)
        for index_rel in {tman.get('mesh', {}).get('indexPath', 'index_mesh.bin'),
                          tman.get('height', {}).get('indexPath', 'index.bin'),
                          tman.get('texture', {}).get('indexPath', 'index_tex.bin')}:
            t_index_path = os.path.join(args.terrain, index_rel)
            if not os.path.exists(t_index_path):
                continue
            with open(t_index_path, 'rb') as fh:
                t_index = unpack_index(fh.read())
            zooms = sorted(t_index)
            for z, coords in deleted.items():
                if z in t_index:
                    t_index[z] -= coords
            with open(t_index_path, 'wb') as fh:
                fh.write(pack_full_index(t_index, zooms[0] if zooms else 0,
                                         zooms[-1] if zooms else 0))
        t_removed = 0
        for z, coords in deleted.items():
            for (x, y) in coords:
                t_removed += remove_tile_files(args.terrain, z, x, y, TERRAIN_EXTS)
        copy_max = int(tman.get('height', {}).get('maxZoom', max_zoom))
        refreshed = 0
        for z, coords in repaired.items():
            if z > copy_max:
                continue
            for (x, y) in coords:
                dst = os.path.join(args.terrain, str(z), str(x), f'{y}.pdm')
                src = os.path.join(args.planet, str(z), str(x), f'{y}.pdm')
                if os.path.exists(dst) and os.path.exists(src):
                    shutil.copyfile(src, dst)
                    refreshed += 1
        tman['areas'] = remaining
        tman['coverage'] = manifest['coverage']
        if isinstance(tman.get('flattenPads'), list):
            tman['flattenPads'] = [p for p in tman['flattenPads']
                                   if keeps_point(p, box, remaining_boxes)]
        af = tman.get('airfields')
        af_path = os.path.join(args.terrain, af['path']) if af and af.get('path') else None
        if af_path and os.path.exists(af_path):
            af_doc = load_json(af_path)
            if isinstance(af_doc.get('items'), list):
                kept = [i for i in af_doc['items']
                        if keeps_point(i, box, remaining_boxes)]
                af_doc['items'] = kept
                af['count'] = len(kept)
                save_json(af_path, af_doc, indent=None)
        save_json(tman_path, tman)
        print(f'terrain     removed {t_removed} files, '
              f'refreshed {refreshed} copied height tiles')

    total_after = sum(len(v) for v in index.values())
    print(f'\nremoved {removed_files} planet files; pyramid now {total_after} '
          f'tiles (was {total_before})'
          + (f'; dropped {dropped_fields} airfields' if dropped_fields else ''))
    print(f'coverage    {manifest["coverage"]}')
    print(f'done in {time.time() - started:.1f}s')
    bbox = f'{box.west},{box.south},{box.east},{box.north}'
    print(f'\nnext: rebake the surviving coarse meshes and their textures over the box:\n'
          f'  npm run bake:mesh -- --bbox {bbox}\n'
          f'  npm run bake:tex -- --bbox {bbox}')
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--name', required=True, help='area name as the manifest records it')
    ap.add_argument('--planet', default='assets/planet', help='height pyramid to delete from')
    ap.add_argument('--terrain', default='assets/terrain', help='draw-ready tree beside it')
    ap.add_argument('--dry-run', action='store_true',
                    help='report what would be deleted and stop')
    args = ap.parse_args(argv)
    try:
        return delete(args)
    except (FileNotFoundError, ValueError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())

"""Tests for tools/delete_area.py.

A miniature two-area pyramid is baked by hand - two z2 tiles sharing one z1
parent - and one area is deleted. What matters: the exclusive tile goes, the
shared ancestors are rebuilt from the survivor rather than deleted or left
stale, both trees' indexes stop listing the dead tiles, and the manifests'
areas / coverage / airfield records shrink to match.

Run with a Python that has numpy and rasterio (the tool imports the bake's
helpers): ``python tools/delete_area_test.py``.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest

import numpy as np

from bake_planet_dem import (
    Bounds,
    build_parent,
    encode_tile,
    read_tile,
    unpack_index,
    write_tile,
)
from delete_area import exclusive_tiles, main, pack_full_index

TILE_SIZE = 5
SEA = 0.0

# One z2 tile each, sharing the z1 parent (0,0) and the z0 root (0,0).
AREA_A = {'name': 'a', 'west': -180.0, 'south': 45.0, 'east': -135.0, 'north': 90.0}
AREA_B = {'name': 'b', 'west': -135.0, 'south': 45.0, 'east': -90.0, 'north': 90.0}


def save_json(path: str, doc: dict) -> None:
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh)


def bake_fixture(root: str) -> tuple[str, str]:
    """A planet and terrain tree holding areas a (height 100) and b (200)."""
    planet = os.path.join(root, 'planet')
    terrain = os.path.join(root, 'terrain')
    os.makedirs(planet)
    os.makedirs(terrain)

    grid_a = np.full((TILE_SIZE, TILE_SIZE), 100.0)
    grid_b = np.full((TILE_SIZE, TILE_SIZE), 200.0)
    write_tile(planet, 2, 0, 0, encode_tile(grid_a, 0.0))
    write_tile(planet, 2, 1, 0, encode_tile(grid_b, 0.0))
    parent = build_parent({(0, 0): grid_a, (1, 0): grid_b}, TILE_SIZE, SEA)
    write_tile(planet, 1, 0, 0, encode_tile(parent, 1.0))
    root_grid = build_parent({(0, 0): parent}, TILE_SIZE, SEA)
    write_tile(planet, 0, 0, 0, encode_tile(root_grid, 2.0))

    tiles = {2: {(0, 0), (1, 0)}, 1: {(0, 0)}, 0: {(0, 0)}}
    with open(os.path.join(planet, 'index.bin'), 'wb') as fh:
        fh.write(pack_full_index(tiles, 0, 2))

    field_a = {'name': 'A-strip', 'lat': 60.0, 'lon': -170.0}
    field_b = {'name': 'B-strip', 'lat': 60.0, 'lon': -100.0}
    save_json(os.path.join(planet, 'manifest.json'), {
        'tileSize': TILE_SIZE, 'minZoom': 0, 'maxZoom': 2, 'seaLevel': SEA,
        'indexPath': 'index.bin',
        'coverage': {'west': -180.0, 'south': 45.0, 'east': -90.0, 'north': 90.0},
        'areas': [AREA_A, AREA_B],
        'airfields': {'items': [field_a, field_b]},
    })

    # The draw-ready tree: a mesh and a copied height tile per planet tile.
    for z, x, y in ((2, 0, 0), (2, 1, 0), (1, 0, 0), (0, 0, 0)):
        d = os.path.join(terrain, str(z), str(x))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f'{y}.ptm'), 'wb') as fh:
            fh.write(b'mesh')
        with open(os.path.join(d, f'{y}.pdm'), 'wb') as fh:
            fh.write(b'copy')
    for name in ('index_mesh.bin', 'index.bin'):
        with open(os.path.join(terrain, name), 'wb') as fh:
            fh.write(pack_full_index(tiles, 0, 2))
    save_json(os.path.join(terrain, 'airfields.json'),
              {'items': [field_a, field_b]})
    save_json(os.path.join(terrain, 'manifest.json'), {
        'coverage': {'west': -180.0, 'south': 45.0, 'east': -90.0, 'north': 90.0},
        'areas': [AREA_A, AREA_B],
        'mesh': {'indexPath': 'index_mesh.bin'},
        'height': {'indexPath': 'index.bin', 'maxZoom': 2},
        'flattenPads': [{'lat': 60.0, 'lon': -170.0}, {'lat': 60.0, 'lon': -100.0}],
        'airfields': {'path': 'airfields.json', 'count': 2},
    })
    return planet, terrain


class DeleteAreaTest(unittest.TestCase):

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.planet, self.terrain = bake_fixture(self.tmp.name)

    def run_tool(self, *extra: str) -> int:
        return main(['--name', 'a', '--planet', self.planet,
                     '--terrain', self.terrain, *extra])

    def test_deletes_exclusive_tiles_and_repairs_shared_ancestors(self) -> None:
        self.assertEqual(self.run_tool(), 0)

        self.assertIsNone(read_tile(self.planet, 2, 0, 0))
        self.assertIsNotNone(read_tile(self.planet, 2, 1, 0))

        # The shared z1 parent survives, rebuilt: area a's quadrant is sea
        # level now, area b's still stands at 200 m.
        rebuilt = read_tile(self.planet, 1, 0, 0)
        self.assertIsNotNone(rebuilt)
        grid, _err = rebuilt
        # Dequantising a reloaded sibling is lossy by half a quantisation step,
        # so compare to millimetres, not bit-exactly.
        self.assertAlmostEqual(grid[0, 0], SEA, delta=1e-3)
        self.assertAlmostEqual(grid[0, TILE_SIZE - 1], 200.0, delta=1e-3)
        # And the repair cascaded to the root.
        root, _err = read_tile(self.planet, 0, 0, 0)
        self.assertAlmostEqual(float(np.max(root)), 200.0, delta=1e-3)

        with open(os.path.join(self.planet, 'index.bin'), 'rb') as fh:
            index = unpack_index(fh.read())
        self.assertEqual(index[2], {(1, 0)})
        self.assertEqual(index[1], {(0, 0)})

        with open(os.path.join(self.planet, 'manifest.json'), encoding='utf-8') as fh:
            manifest = json.load(fh)
        self.assertEqual([a['name'] for a in manifest['areas']], ['b'])
        self.assertEqual(manifest['coverage']['west'], AREA_B['west'])
        self.assertEqual([f['name'] for f in manifest['airfields']['items']],
                         ['B-strip'])

    def test_prunes_the_terrain_tree_alongside(self) -> None:
        self.assertEqual(self.run_tool(), 0)

        gone = os.path.join(self.terrain, '2', '0', '0.ptm')
        kept = os.path.join(self.terrain, '2', '1', '0.ptm')
        self.assertFalse(os.path.exists(gone))
        self.assertFalse(os.path.exists(os.path.join(self.terrain, '2', '0', '0.pdm')))
        self.assertTrue(os.path.exists(kept))

        for name in ('index_mesh.bin', 'index.bin'):
            with open(os.path.join(self.terrain, name), 'rb') as fh:
                index = unpack_index(fh.read())
            self.assertEqual(index[2], {(1, 0)}, name)

        # Repaired ancestors' height copies are refreshed from the planet tree
        # - a real PDM1 tile now, not the fixture's placeholder bytes.
        refreshed = read_tile(self.terrain, 1, 0, 0)
        self.assertIsNotNone(refreshed)
        self.assertEqual(refreshed[0][0, 0], SEA)

        with open(os.path.join(self.terrain, 'manifest.json'), encoding='utf-8') as fh:
            tman = json.load(fh)
        self.assertEqual([a['name'] for a in tman['areas']], ['b'])
        self.assertEqual(len(tman['flattenPads']), 1)
        self.assertEqual(tman['airfields']['count'], 1)
        with open(os.path.join(self.terrain, 'airfields.json'), encoding='utf-8') as fh:
            self.assertEqual([f['name'] for f in json.load(fh)['items']], ['B-strip'])

    def test_dry_run_touches_nothing(self) -> None:
        self.assertEqual(self.run_tool('--dry-run'), 0)
        self.assertIsNotNone(read_tile(self.planet, 2, 0, 0))
        with open(os.path.join(self.planet, 'manifest.json'), encoding='utf-8') as fh:
            self.assertEqual(len(json.load(fh)['areas']), 2)

    def test_refuses_unknown_and_last_area(self) -> None:
        self.assertEqual(main(['--name', 'nope', '--planet', self.planet,
                               '--terrain', self.terrain]), 2)
        self.assertEqual(self.run_tool(), 0)
        # Only b is left now; deleting it would delete the whole pyramid.
        self.assertEqual(main(['--name', 'b', '--planet', self.planet,
                               '--terrain', self.terrain]), 2)
        self.assertIsNotNone(read_tile(self.planet, 2, 1, 0))

    def test_overlapped_tiles_stay(self) -> None:
        # A third area claiming area a's very tile: nothing of a is exclusive,
        # so no tile data moves, only the manifest entry.
        with open(os.path.join(self.planet, 'manifest.json'), encoding='utf-8') as fh:
            manifest = json.load(fh)
        manifest['areas'].append({**AREA_A, 'name': 'c'})
        save_json(os.path.join(self.planet, 'manifest.json'), manifest)

        self.assertEqual(self.run_tool(), 0)
        self.assertIsNotNone(read_tile(self.planet, 2, 0, 0))
        grid, _err = read_tile(self.planet, 1, 0, 0)
        self.assertAlmostEqual(grid[0, 0], 100.0, delta=1e-3)

    def test_exclusive_tiles_respects_edge_touching_neighbours(self) -> None:
        present = {(0, 0), (1, 0)}
        box = Bounds(AREA_A['west'], AREA_A['south'], AREA_A['east'], AREA_A['north'])
        neighbour = Bounds(AREA_B['west'], AREA_B['south'], AREA_B['east'], AREA_B['north'])
        self.assertEqual(exclusive_tiles(2, box, [neighbour], present), {(0, 0)})
        overlapping = Bounds(-160.0, 45.0, -135.0, 90.0)
        self.assertEqual(exclusive_tiles(2, box, [overlapping], present), set())

    def test_pack_full_index_keeps_empty_levels_in_place(self) -> None:
        packed = pack_full_index({0: {(0, 0)}, 2: {(3, 1)}}, 0, 2)
        self.assertEqual(unpack_index(packed),
                         {0: {(0, 0)}, 1: set(), 2: {(3, 1)}})


if __name__ == '__main__':
    unittest.main()
